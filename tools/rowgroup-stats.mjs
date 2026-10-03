// tools/rowgroup-stats.mjs — row-group pruning analysis for an export.
// Usage: node rowgroup-stats.mjs <data>/<version> [level]   (default csd)
//
// For each t_code, how many row groups have
// min/max stats that admit (a) t_code = X AND time = Y  (values / map)
// and (b) t_code = X (series, meta), and the compressed bytes of the
// columns those queries read in those row groups.
import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs";
const D = process.argv[2], LVL = process.argv[3] || "csd";
const man = JSON.parse(fs.readFileSync(`${D}/../manifest.json`));
const c = await (await DuckDBInstance.create(":memory:")).connect();
const q = async (s) => (await c.runAndReadAll(s)).getRowObjectsJson();
const files = man.facts[LVL].map((f) => `${D}/${f.file}`);
const meta = await q(`
  SELECT file_name f, row_group_id rg, row_group_num_rows n, path_in_schema col,
         stats_min_value mn, stats_max_value mx, total_compressed_size bytes
  FROM parquet_metadata([${files.map((f) => `'${f}'`).join(",")}])`);
// per row group: t_code/time ranges and per-column bytes
const rgs = new Map();
for (const m of meta) {
  const k = `${m.f}#${m.rg}`;
  const r = rgs.get(k) ?? { file: m.f, n: Number(m.n), cols: {} };
  r.cols[m.col] = { mn: m.mn, mx: m.mx, bytes: Number(m.bytes) };
  rgs.set(k, r);
}
const all = [...rgs.values()];
console.log(`${LVL}: ${files.length} files, ${all.length} row groups, ${Math.round(all.reduce((s, r) => s + r.n, 0) / all.length)} rows/RG avg`);
const VALUES_COLS = ["t_code", "time", "level", "loc", "geosid", "val_t"];
const bytesOf = (rs, cols) => rs.reduce((s, r) => s + cols.reduce((t, c) => t + (r.cols[c]?.bytes ?? 0), 0), 0);
const pairs = await q(`SELECT t_code, "time", count(*) n FROM read_parquet([${files.map((f) => `'${f}'`).join(",")}]) GROUP BY ALL`);
const codes = [...new Set(pairs.map((p) => p.t_code))];
const stat = (xs) => { xs.sort((a, b) => a - b); const p = (k) => xs[Math.floor(k * (xs.length - 1))]; return `median ${p(0.5)}, p90 ${p(0.9)}, max ${xs[xs.length - 1]}`; };
const rgA = [], kbA = [], rgB = [], kbB = [], rowsA = [];
for (const p of pairs) {
  const hit = all.filter((r) => r.cols.t_code.mn <= p.t_code && p.t_code <= r.cols.t_code.mx &&
    Number(r.cols.time.mn) <= p.time && p.time <= Number(r.cols.time.mx));
  rgA.push(hit.length); kbA.push(Math.round(bytesOf(hit, VALUES_COLS) / 1024)); rowsA.push(Number(p.n));
}
for (const code of codes) {
  const hit = all.filter((r) => r.cols.t_code.mn <= code && code <= r.cols.t_code.mx);
  rgB.push(hit.length); kbB.push(Math.round(bytesOf(hit, ["t_code", "geosid", "level", "loc", "time", "val_t"]) / 1024));
}
console.log(`(a) t_code+time (map values), ${pairs.length} pairs: row groups ${stat(rgA)}; kB read ${stat(kbA)}; rows wanted ${stat(rowsA)}`);
console.log(`(b) t_code only (series/meta), ${codes.length} codes: row groups ${stat(rgB)}; kB read ${stat(kbB)}`);
const rgBytes = all.map((r) => Object.values(r.cols).reduce((s, c) => s + c.bytes, 0));
console.log(`row group size: ${stat(rgBytes.map((b) => Math.round(b / 1024)))} kB; column chunks per RG: ${Object.keys(all[0].cols).length}`);
