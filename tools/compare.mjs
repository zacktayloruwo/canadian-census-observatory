// tools/compare.mjs
//
// Equivalence check: run the ported API (frontend/src/data/routes.js) in Node
// over the exported Parquet files and compare every answer with the live
// Express server from the original repo.
//
// Usage: node compare.mjs [--server http://localhost:3001] [--data ../frontend/public/data]
//
// Requests are built from the server's own catalogue (themes → codes), plus a
// fixed set of known-hard cases (lineages, code reuse, 1911, 1961 CD).

import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "../frontend/src/data/routes.js";
import { baseTableStatements, createFactRouter } from "../frontend/src/data/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SERVER = arg("server", "http://localhost:3001");
const DATA = path.resolve(arg("data", path.join(here, "../frontend/public/data")));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "manifest.json"), "utf8"));
const VDIR = path.join(DATA, manifest.version);

// ── Ported API over Parquet, in Node ─────────────────────────────────────────
// Same file routing as the browser (schema.js createFactRouter), so these
// checks also prove each query finds all its rows in the files it opens.
const src = (f) => path.join(VDIR, f);
const conn = await (await DuckDBInstance.create(":memory:")).connect();
for (const sql of baseTableStatements(manifest, src)) await conn.run(sql);
const index = manifest.tables.facts_index
  ? JSON.parse(fs.readFileSync(src(manifest.tables.facts_index.file), "utf8"))
  : null;
const route = createFactRouter(manifest, index, src, (sql) => conn.run(sql));
let queue = Promise.resolve(); // routing repoints views: one query at a time
const duckAll = (sql, params = []) => {
  const run = async () => {
    await route(sql, params);
    return (await conn.runAndReadAll(sql, params)).getRowObjects().map((row) => {
      const out = {};
      for (const k in row) out[k] = typeof row[k] === "bigint" ? Number(row[k]) : row[k];
      return out;
    });
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
};
const api = await createApi({
  duckAll,
  readJson: async (name) => JSON.parse(fs.readFileSync(path.join(VDIR, manifest.tables[name].file), "utf8")),
  readTopology: async (year, level = null, key = null) => {
    const f = key ? manifest.topology[year]?.parts?.[level]?.[key] : manifest.topology[year];
    return f ? JSON.parse(fs.readFileSync(path.join(VDIR, f.file), "utf8")) : null;
  },
  topologyParts: (year, level) => manifest.topology[year]?.parts?.[level] ?? {},
});

const local = async (url) => {
  const u = new URL(url, "http://x");
  return api.handle(u.pathname, Object.fromEntries(u.searchParams));
};
const remote = async (url) => {
  const r = await fetch(SERVER + url);
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ── Comparison ───────────────────────────────────────────────────────────────
// Row order of SQL without ORDER BY is unspecified; sort those arrays first.
const UNORDERED = { "/api/values": (b) => b?.rows?.sort((a, c) => String(a.geosid).localeCompare(String(c.geosid))) };
// Geometry differs by construction (WKB vs bundle); compare feature identity only.
const GEOMETRY = new Set(["/api/geometry", "/api/boundaries", "/api/geo-polygon"]);
const shapeOf = (b) =>
  b?.type === "FeatureCollection"
    ? { type: b.type, geosids: b.features.map((f) => String(f.properties.geosid)).sort() }
    : b?.type === "Feature"
      ? { type: b.type, properties: b.properties, geomType: b.geometry?.type }
      : b;

function diff(a, b, at = "") {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) ? null : `${at}: ${a} ≠ ${b}`;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b ? null : `${at}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
  if (Array.isArray(a) && a.length !== b.length) return `${at}: length ${a.length} ≠ ${b.length}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = diff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

let pass = 0, fail = 0;
async function check(url) {
  const [L, R] = await Promise.all([local(url), remote(url)]);
  const p = url.split("?")[0];
  UNORDERED[p]?.(L.body); UNORDERED[p]?.(R.body);
  const [lb, rb] = GEOMETRY.has(p) ? [shapeOf(L.body), shapeOf(R.body)] : [L.body, R.body];
  const d = L.status !== R.status ? `status ${L.status} ≠ ${R.status}` : diff(lb, rb);
  if (d) { fail++; console.log(`FAIL ${url}\n     ${d}`); } else pass++;
  return R.body;
}

// ── Requests ─────────────────────────────────────────────────────────────────
const fixed = [
  "/api/ping",
  "/api/geos?q=winnipeg", "/api/geos?q=3506", "/api/geos?q=", "/api/geos?q=beckwith",
  "/api/level?year=2021&geosid=4611040", "/api/level?year=1911&geosid=4610001", "/api/level?year=2021&geosid=nope",
  "/api/ct-cma?year=2021", "/api/ct-cma?year=1951",
  "/api/geoyears?geosid=4611040&year=2021&level=2", "/api/geoyears?geosid=3506008&year=1911",
  "/api/geoyears?geosid=3541009&year=1861", "/api/geoyears?geosid=35",
  "/api/lineage?geosid=4611040&year=2021&level=2", "/api/lineage?geosid=3518002&year=1861", "/api/lineage?geosid=35&year=2021",
  "/api/code-levels?t_code=dnk2&year=2021", "/api/code-levels?t_code=dnk2&year=1851",
  "/api/code-years?level=2&t_code=dnk2", "/api/code-years?level=1&t_code=dnk2",
  "/api/nc-ref-value?geosid=35&year=2021&t_code=dnk2",
  "/api/series?focal_geosid=4611040&ref_geosid=46&year=2021&t_code=dnk2",
  "/api/series?focal_geosid=4610001&year=1911&t_code=dnk2",
  "/api/series?focal_geosid=3506008&ref_geosid=35&year=2021&t_code=dnk2",
  "/api/boundaries?level=5&year=2021", "/api/boundaries?level=5&year=1881",
  "/api/geometry?level=3&year=1911", "/api/geometry?level=4&year=2021",
  "/api/geometry?level=1&year=2021", "/api/geometry?level=1&year=1951", // tracts from per-CMA bundles
  "/api/geo-polygon?geosid=5350001.00&year=2021", "/api/geo-polygon?geosid=5050001.00&year=1976",
  // CSDs and CDs from per-province parts, incl. a disputed-territory year
  "/api/geometry?level=2&year=2021", "/api/geometry?level=2&year=1921", "/api/geometry?level=3&year=1881",
  "/api/geo-polygon?geosid=3506008&year=2021", "/api/geo-polygon?geosid=3506&year=2021",
  "/api/geo-polygon?geosid=4610001&year=1911", "/api/boundaries?level=3&year=2021",
  "/api/geo-polygon?geosid=35&year=2021", "/api/geo-polygon?geosid=4611040&year=1966",
  "/api/values?level=1&year=2021&t_code=dnk2",
  // variables a level doesn't have: the router reads an empty table
  "/api/values?level=2&year=2021&t_code=nope", "/api/nc-ref-value?geosid=35&year=2021&t_code=nope",
  "/api/series?focal_geosid=3506008&ref_geosid=35&year=2021&t_code=nope",
  "/api/cs-plot?level=2&year=2021&t_theme=dwpr&geosid=3506008&ref_geosid=35",
];
for (const u of fixed) await check(u);

// Catalogue-driven: per level × a spread of years, every theme's first code
// through values / plots / series, focal + comparison geographies.
const SAMPLES = [
  { level: 1, year: 2021, focal: "5350001.00", ref: "535" },
  { level: 1, year: 1951, focal: "5350001.00", ref: "35" },
  { level: 2, year: 2021, focal: "4611040", ref: "46" },
  { level: 2, year: 1911, focal: "4610001", ref: "4611" },
  { level: 3, year: 1961, focal: "1209", ref: "12" },
  { level: 3, year: 1871, focal: "3506", ref: "35" },
  { level: 4, year: 2016, focal: "602", ref: "46" },
  { level: 5, year: 1901, focal: "35", ref: "24" },
];
const THEMES = JSON.parse(fs.readFileSync(path.join(VDIR, "themes.json"), "utf8"));
const typeOf = new Map(THEMES.map((t) => [t.t_theme, t.t_type]));

for (const s of SAMPLES) {
  const themes = (await check(`/api/themes?level=${s.level}&year=${s.year}`)) || [];
  for (const th of themes) {
    await check(`/api/years?level=${s.level}&t_theme=${th.t_theme}`);
    const codes = (await check(`/api/codes?level=${s.level}&t_theme=${th.t_theme}&year=${s.year}`)) || [];
    const geo = `geosid=${encodeURIComponent(s.focal)}&ref_geosid=${encodeURIComponent(s.ref)}`;
    const t = typeOf.get(th.t_theme);
    if (t === "cat" || t === "catm") await check(`/api/cs-plot?level=${s.level}&year=${s.year}&t_theme=${th.t_theme}&${geo}`);
    if (t === "ord" || t === "ordc") await check(`/api/os-plot?level=${s.level}&year=${s.year}&t_theme=${th.t_theme}&${geo}`);
    for (const c of codes.slice(0, 2)) {
      const tc = encodeURIComponent(c.t_code);
      await check(`/api/values?level=${s.level}&year=${s.year}&t_code=${tc}`);
      await check(`/api/nc-ref-value?geosid=${encodeURIComponent(s.ref)}&year=${s.year}&t_code=${tc}&value_mode=percent`);
      for (const mode of ["raw", "percent"]) {
        await check(`/api/series?focal_geosid=${encodeURIComponent(s.focal)}&ref_geosid=${encodeURIComponent(s.ref)}&year=${s.year}&t_code=${tc}&value_mode=${mode}`);
      }
    }
  }
}

console.log(`\n${pass} identical, ${fail} different`);
process.exit(fail ? 1 : 0);
