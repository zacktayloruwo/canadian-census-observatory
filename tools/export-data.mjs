// tools/export-data.mjs
//
// Export the observatory DuckDB build (the file the Express app serves) to the
// static files the browser app reads through DuckDB-WASM:
//
//   <out>/manifest.json                  entry point; names the versioned dir
//   <out>/<version>/facts/<lvl>_<n>.parquet  fact tables, split to stay < 50 MB
//   <out>/<version>/all_descr.parquet    variable catalogue (+ rid = original rowid)
//   <out>/<version>/hlook.json, lineage.json  lookups, column-wise JSON
//   <out>/<version>/geos.json, themes.json
//   <out>/<version>/topology/topology_<year>.json
//
// Every data file sits under a version directory so a deploy never changes a
// file a running session is range-reading; only manifest.json is overwritten.
//
// Usage: node export-data.mjs [--src <dir with observatory_v3.duckdb>] [--out <dir>]
//        defaults: ../../unicen_js/backend/data  →  ../frontend/public/data

import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SRC = path.resolve(arg("src", path.join(here, "../../unicen_js/backend/data")));
const OUT = path.resolve(arg("out", path.join(here, "../frontend/public/data")));
const DB = path.join(SRC, "observatory_v3.duckdb");

// Rows per fact file. ~1.75 bytes/row compressed, so 20M rows ≈ 35 MB —
// under GitHub's 50 MB warning and 100 MB hard limit.
const MAX_ROWS_PER_FILE = 20_000_000;
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

// Version = DATA_LAST_UPDATED-style date plus the source DB's mtime, so two
// exports of the same build land in the same directory.
const mtime = fs.statSync(DB).mtime;
const version = `v${mtime.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
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

  // Split on t_theme boundaries (the leading sort key) so a theme's rows,
  // and therefore every query's rows, stay inside one file.
  const themes = await all(`SELECT t_theme, count(*) n FROM ${lvl} WHERE loc = 't' GROUP BY 1 ORDER BY 1 NULLS LAST`);
  const chunks = [];
  let cur = [], rows = 0;
  for (const t of themes) {
    const n = Number(t.n);
    if (cur.length && rows + n > MAX_ROWS_PER_FILE) { chunks.push(cur); cur = []; rows = 0; }
    cur.push(t.t_theme); rows += n;
  }
  if (cur.length) chunks.push(cur);

  manifest.facts[lvl] = [];
  for (const [i, chunk] of chunks.entries()) {
    const file = `facts/${lvl}_${i}.parquet`;
    // A few rows carry no t_theme; they sort last and ride in the last file.
    const named = chunk.filter((t) => t != null);
    const lo = named[0], hi = named[named.length - 1];
    const where = `t_theme BETWEEN ${q(lo)} AND ${q(hi)}` +
      (named.length < chunk.length ? " OR t_theme IS NULL" : "");
    await run(`
      COPY (
        SELECT ${FACT_COLS} FROM ${lvl}
        WHERE loc = 't' AND (${where})
        ORDER BY t_theme NULLS LAST, t_code, "time", geosid
      ) TO ${q(path.join(VDIR, file))}
      (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`);
    const bytes = fs.statSync(path.join(VDIR, file)).size;
    manifest.facts[lvl].push({ file, bytes, themes: [lo, hi] });
    console.log(`${file}  ${(bytes / 1e6).toFixed(1)} MB  themes ${lo}..${hi}`);
  }
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

// TopoJSON bundles. Renamed to .json so GitHub Pages serves them gzipped.
const topoDir = path.join(SRC, "topology_v3");
for (const f of fs.readdirSync(topoDir).filter((f) => /^topology_\d{4}\.topojson$/.test(f)).sort()) {
  const year = f.match(/\d{4}/)[0];
  const file = `topology/topology_${year}.json`;
  fs.copyFileSync(path.join(topoDir, f), path.join(VDIR, file));
  manifest.topology[year] = { file, bytes: fs.statSync(path.join(VDIR, file)).size };
}
console.log(`topology: ${Object.keys(manifest.topology).length} bundles`);

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
const total = [...Object.values(manifest.facts).flat(), ...Object.values(manifest.tables), ...Object.values(manifest.topology)]
  .reduce((s, f) => s + f.bytes, 0);
console.log(`manifest.json written; ${(total / 1e6).toFixed(0)} MB under ${version}/`);
