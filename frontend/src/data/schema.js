// frontend/src/data/schema.js
//
// SQL that recreates the server's table names on top of the static files
// listed in data/manifest.json (written by tools/export-data.mjs), so the
// ported route SQL in routes.js runs unchanged.
//
//   fact tables ct/csd/cd/cma/pr → views over the Parquet files, read lazily
//     by HTTP range request; row-group statistics keep a query to the few
//     row groups holding its t_code
//   all_descr → small, copied into memory once
//   (hlook and the geouid concordance are not tables: routes.js reads them
//   from pre-extracted JSON straight into maps)
//
// `src(file)` maps a manifest path to whatever read_parquet() should open:
// a registered file name in the browser, a local path in Node.

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

export const FACT_TABLES = ["ct", "csd", "cd", "cma", "pr"];

/** CREATE VIEW for one fact table. Binding it reads every file's footer
 *  (~150 KB each for ct/csd), so the browser creates views on first use. */
export function factViewSql(manifest, level, src) {
  const list = manifest.facts[level].map((f) => lit(src(f.file))).join(", ");
  return `CREATE OR REPLACE VIEW ${level} AS SELECT * FROM read_parquet([${list}])`;
}

/** Fact tables a query reads (FROM/JOIN ct|csd|cd|cma|pr). */
export function factTablesIn(sql) {
  return [...new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+(ct|csd|cd|cma|pr)\b/gi)].map((m) => m[1].toLowerCase()))];
}

/** In-memory tables, created at start-up. */
export function baseTableStatements(manifest, src) {
  // all_descr keeps the server's row order: routes order codes by rowid.
  return [`CREATE OR REPLACE TABLE all_descr AS
    SELECT * EXCLUDE (rid) FROM read_parquet(${lit(src(manifest.tables.all_descr.file))}) ORDER BY rid`];
}

/** Everything at once (Node tools). */
export function schemaStatements(manifest, src) {
  return [...FACT_TABLES.map((l) => factViewSql(manifest, l, src)), ...baseTableStatements(manifest, src)];
}
