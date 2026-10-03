// tools/export-data.mjs
//
// Export the observatory DuckDB build (the file the Express app serves) to the
// static files the browser app reads through DuckDB-WASM:
//
//   <out>/manifest.json                  entry point; names the versioned dir
//   <out>/<version>/facts/<lvl>_<n>.parquet  fact tables, small files (~3.5 MB)
//   <out>/<version>/facts_index.json     which files hold each t_code / t_theme
//   <out>/<version>/all_descr.parquet    variable catalogue (+ rid = original rowid)
//   <out>/<version>/hlook.json, lineage.json  lookups, column-wise JSON
//   <out>/<version>/geos.json, themes.json
//   <out>/<version>/topology/topology_<year>.json
//
// Every data file sits under a version directory so a deploy never changes a
// file a running session is range-reading; only manifest.json is overwritten.
//
// Usage: node export-data.mjs [--src <dir with observatory_v3.duckdb>] [--out <dir>]
//                              [--max-rows <rows per fact file>]
//        defaults: ../../unicen_js/backend/data  →  ../frontend/public/data,
//        2,000,000 rows per fact file

import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitByCma } from "./topology-split.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SRC = path.resolve(arg("src", path.join(here, "../../unicen_js/backend/data")));
const OUT = path.resolve(arg("out", path.join(here, "../frontend/public/data")));
const DB = path.join(SRC, "observatory_v3.duckdb");

// Rows per fact file (~1.75 bytes/row, so 2M rows ≈ 3.5 MB). Small files on
// purpose: on a cache miss GitHub Pages' CDN fetches the WHOLE file before
// answering a range request (3.4 s for an 89 MB file, 0.2 s for 1.7 MB), and
// sometimes answers with the whole file instead of the range. The browser
// opens only the files a query needs (facts_index.json, see
// frontend/src/data/schema.js), so a miss costs one small file.
const MAX_ROWS_PER_FILE = Number(arg("max-rows", 2_000_000));
const ROW_GROUP_SIZE = 100_000;
const LEVELS = ["ct", "csd", "cd", "cma", "pr"];

if (!fs.existsSync(DB)) {
  console.error(`No database at ${DB} (pass --src)`);
  process.exit(1);
}

const inst = await DuckDBInstance.create(DB, { access_mode: "READ_ONLY" });
const conn = await inst.connect();
const all = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
const run = (sql) => conn.run(sql);
const q = (s) => `'${s.replaceAll("'", "''")}'`;

// Version = the source DB's mtime plus the export layout, so two exports of
// the same build with the same layout land in the same directory, and a
// layout change never reuses a URL a browser may hold in its cache.
// Bump LAYOUT whenever the files' names or contents change for the same DB.
const LAYOUT = 5; // 2: one fact file per level; 3: small files + facts_index.json;
                  // 4: + themeYears in the index, fact_schema in the manifest;
                  // 5: census tract boundaries split out per CMA
const mtime = fs.statSync(DB).mtime;
const version = `v${mtime.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-l${LAYOUT}-r${MAX_ROWS_PER_FILE}`;
const VDIR = path.join(OUT, version);
fs.mkdirSync(path.join(VDIR, "facts"), { recursive: true });
fs.mkdirSync(path.join(VDIR, "topology"), { recursive: true });
console.log(`source  ${DB}\noutput  ${VDIR}`);

// The app reads only these fact columns (checked against backend/server.js).
// loc is kept although every row is 't' (the build drops the rest) so the
// ported SQL keeps its loc = 't' guards unchanged; dictionary-encoded, it
// costs nothing.
const FACT_COLS = `
  time::SMALLINT   AS "time",
  level::TINYINT   AS level,
  loc,
  geosid,
  t_theme,
  t_code,
  t_level::TINYINT AS t_level,
  t_denom,
  val_t`;

const manifest = { version, data_last_updated: mtime.toISOString().slice(0, 10), facts: {}, tables: {}, topology: {} };

// facts_index.json: per level, which files (indexes into manifest.facts[lvl])
// hold each t_code and each t_theme. The browser opens only those files.
const factsIndex = {};
const addTo = (map, key, chunk) => {
  const list = (map[key] ??= []);
  if (!list.includes(chunk)) list.push(chunk);
};

for (const lvl of LEVELS) {
  // Guard the narrowing casts above.
  const [chk] = await all(`
    SELECT count(*) FILTER (WHERE t_level <> round(t_level) OR abs(t_level) > 127) bad_tlevel,
           count(*) FILTER (WHERE level <> round(level))     bad_level,
           count(*) FILTER (WHERE loc <> 't')                 non_total
    FROM ${lvl}`);
  if (Number(chk.bad_tlevel) || Number(chk.bad_level)) {
    throw new Error(`${lvl}: t_level/level not integral: ${JSON.stringify(chk)}`);
  }

  // Split between (t_theme, t_code) groups, in file sort order, so a code's
  // rows never straddle two files (a large theme may span several).
  const groups = await all(`
    SELECT t_theme, t_code, count(*) n FROM ${lvl} WHERE loc = 't'
    GROUP BY ALL ORDER BY t_theme NULLS LAST, t_code NULLS LAST`);
  let chunk = 0, rows = 0;
  for (const g of groups) {
    const n = Number(g.n);
    if (rows > 0 && rows + n > MAX_ROWS_PER_FILE) { chunk++; rows = 0; }
    g.chunk = chunk;
    rows += n;
  }

  // Tag every row with its chunk once, then write each chunk from the staged
  // (sorted) copy, rather than re-filtering the source table per file.
  await run(`CREATE OR REPLACE TEMP TABLE chunkmap (t_theme VARCHAR, t_code VARCHAR, chunk INTEGER)`);
  for (let i = 0; i < groups.length; i += 1000) {
    const values = groups.slice(i, i + 1000).map((g) =>
      `(${g.t_theme == null ? "NULL" : q(g.t_theme)}, ${g.t_code == null ? "NULL" : q(g.t_code)}, ${g.chunk})`);
    await run(`INSERT INTO chunkmap VALUES ${values.join(", ")}`);
  }
  await run(`
    CREATE OR REPLACE TEMP TABLE staged AS
    SELECT x.*, m.chunk
    FROM (SELECT ${FACT_COLS} FROM ${lvl} WHERE loc = 't') x
    JOIN chunkmap m
      ON x.t_theme IS NOT DISTINCT FROM m.t_theme
     AND x.t_code  IS NOT DISTINCT FROM m.t_code
    ORDER BY x.t_theme NULLS LAST, x.t_code NULLS LAST, x."time", x.geosid`);

  manifest.facts[lvl] = [];
  factsIndex[lvl] = { codes: {}, themes: {}, themeYears: {} };
  for (let i = 0; i <= chunk; i++) {
    const file = `facts/${lvl}_${i}.parquet`;
    await run(`
      COPY (SELECT * EXCLUDE (chunk) FROM staged WHERE chunk = ${i})
      TO ${q(path.join(VDIR, file))}
      (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`);
    manifest.facts[lvl].push({ file, bytes: fs.statSync(path.join(VDIR, file)).size });
  }
  for (const g of groups) {
    if (g.t_code != null) addTo(factsIndex[lvl].codes, g.t_code, g.chunk);
    if (g.t_theme != null) addTo(factsIndex[lvl].themes, g.t_theme, g.chunk);
  }
  // themeYears[theme][year]: files holding that theme's rows for one census
  // year. Plot queries name a theme and a year, and variables are mostly
  // per year, so this opens a fraction of a large theme's files.
  for (const r of await all(`SELECT DISTINCT t_theme, "time", chunk FROM staged WHERE t_theme IS NOT NULL`)) {
    addTo((factsIndex[lvl].themeYears[r.t_theme] ??= {}), String(r.time), r.chunk);
  }
  const mb = manifest.facts[lvl].map((f) => f.bytes / 1e6);
  console.log(`${lvl}: ${mb.length} files, ${Math.min(...mb).toFixed(1)}-${Math.max(...mb).toFixed(1)} MB`);
  // Column names and types of the fact files, for the browser's empty table.
  manifest.fact_schema ??= (await all(`DESCRIBE SELECT * EXCLUDE (chunk) FROM staged`))
    .map((r) => [r.column_name, r.column_type]);
  await run("DROP TABLE staged");
}

// all_descr: queried by SQL (joins in the plot routes), so it goes into the
// browser's DuckDB. The API orders codes by rowid, so the original rowid
// travels along as rid and the browser recreates the table in that order.
{
  const file = "all_descr.parquet";
  await run(`COPY (SELECT rowid AS rid, * FROM all_descr ORDER BY rowid)
    TO ${q(path.join(VDIR, file))} (FORMAT parquet, COMPRESSION zstd)`);
  manifest.tables.all_descr = { file, bytes: fs.statSync(path.join(VDIR, file)).size };
}

// Plot queries select a theme's rows through all_descr (JOIN ... d.t_theme = ?),
// so a theme must also cover the files of every code all_descr lists under
// it at that level, whatever t_theme the fact rows themselves carry.
for (const { level, time, t_theme, t_code } of await all(
  `SELECT DISTINCT level, "time", t_theme, t_code FROM all_descr WHERE t_theme IS NOT NULL AND t_code IS NOT NULL`
)) {
  const idx = factsIndex[level];
  for (const chunk of idx?.codes[t_code] ?? []) {
    addTo(idx.themes, t_theme, chunk);
    if (time != null) addTo((idx.themeYears[t_theme] ??= {}), String(time), chunk);
  }
}
fs.writeFileSync(path.join(VDIR, "facts_index.json"), JSON.stringify(factsIndex));
manifest.tables.facts_index = { file: "facts_index.json", bytes: fs.statSync(path.join(VDIR, "facts_index.json")).size };

// hlook and the geouid concordance are never queried by SQL: the API reads
// them once into in-memory maps. They ship pre-extracted as column-wise JSON
// ({ column: [values] }) — the browser parses that natively in a fraction of
// the time it took to pull 260k rows out of DuckDB-WASM (~5 s at start-up).
const LOOKUPS = {
  hlook: `SELECT geosid, year, level, geoname, prname, prabbr, pruid, cmaname FROM hlook`,
  lineage: `SELECT level, time, geosid, geouid, status, geoname, in_scope FROM geouid_concordance`,
};
for (const [name, sql] of Object.entries(LOOKUPS)) {
  const file = `${name}.json`;
  const cols = (await conn.runAndReadAll(sql)).getColumnsObjectJson();
  fs.writeFileSync(path.join(VDIR, file), JSON.stringify(cols));
  manifest.tables[name] = { file, bytes: fs.statSync(path.join(VDIR, file)).size };
  console.log(`${file}  ${(manifest.tables[name].bytes / 1e6).toFixed(1)} MB`);
}

// JSON sidecars, copied as is.
for (const [src, dst] of [["geos_v3.json", "geos.json"], ["themes.json", "themes.json"]]) {
  fs.copyFileSync(path.join(SRC, src), path.join(VDIR, dst));
  manifest.tables[dst.replace(".json", "")] = { file: dst, bytes: fs.statSync(path.join(VDIR, dst)).size };
}

// TopoJSON bundles, renamed to .json so GitHub Pages serves them gzipped.
// Census tracts are split out per CMA (topology-split.mjs): the base file of
// a year holds every other level, and the map loads tract files only for the
// CMAs in view. manifest.topology[year].ct[cmauid] = { file, bytes, bbox }.
const topoDir = path.join(SRC, "topology_v3");
let ctFiles = 0;
for (const f of fs.readdirSync(topoDir).filter((f) => /^topology_\d{4}\.topojson$/.test(f)).sort()) {
  const year = f.match(/\d{4}/)[0];
  const { base, ct } = splitByCma(JSON.parse(fs.readFileSync(path.join(topoDir, f), "utf8")));
  const file = `topology/topology_${year}.json`;
  fs.writeFileSync(path.join(VDIR, file), JSON.stringify(base));
  const entry = { file, bytes: fs.statSync(path.join(VDIR, file)).size, ct: {} };
  if (Object.keys(ct).length) fs.mkdirSync(path.join(VDIR, "topology", "ct", year), { recursive: true });
  for (const [cma, topo] of Object.entries(ct)) {
    const ctFile = `topology/ct/${year}/${cma}.json`;
    fs.writeFileSync(path.join(VDIR, ctFile), JSON.stringify(topo));
    entry.ct[cma] = { file: ctFile, bytes: fs.statSync(path.join(VDIR, ctFile)).size, bbox: topo.bbox };
    ctFiles++;
  }
  manifest.topology[year] = entry;
}
console.log(`topology: ${Object.keys(manifest.topology).length} base bundles, ${ctFiles} CT files (per CMA)`);

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
const total = [...Object.values(manifest.facts).flat(), ...Object.values(manifest.tables),
  ...Object.values(manifest.topology).flatMap((t) => [t, ...Object.values(t.ct ?? {})])]
  .reduce((s, f) => s + f.bytes, 0);
console.log(`manifest.json written; ${(total / 1e6).toFixed(0)} MB under ${version}/`);
