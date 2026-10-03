// frontend/src/data/schema.js
//
// SQL that recreates the server's table names on top of the static files
// listed in data/manifest.json (written by tools/export-data.mjs), so the
// ported route SQL in routes.js runs unchanged.
//
//   fact tables ct/csd/cd/cma/pr → views over the Parquet files, read lazily
//     by HTTP range request. Each level is split into ~3.5 MB files, and
//     before every query the router repoints the view at only the files
//     holding the query's variables (facts_index.json); row-group statistics
//     then keep the read to the few row groups holding its t_code
//   all_descr → small, copied into memory once
//   (hlook and the geouid concordance are not tables: routes.js reads them
//   from pre-extracted JSON straight into maps)
//
// `src(file)` maps a manifest path to whatever read_parquet() should open:
// a registered file name in the browser, a local path in Node.

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

export const FACT_TABLES = ["ct", "csd", "cd", "cma", "pr"];

/** CREATE VIEW for one fact table over some of its files (default: all).
 *  Binding a view reads each listed file's footer. */
export function factViewSql(manifest, level, src, fileIdxs = manifest.facts[level].map((_, i) => i)) {
  const list = fileIdxs.map((i) => lit(src(manifest.facts[level][i].file))).join(", ");
  return `CREATE OR REPLACE VIEW ${level} AS SELECT * FROM read_parquet([${list}])`;
}

/** Files of a level holding any t_code or t_theme among a query's string
 *  params, or every file when none match (always correct, just slower). A
 *  param that only looks like a code (a level name, say) widens the set,
 *  never narrows it. */
export function filesForParams(levelIndex, fileCount, params) {
  const files = new Set();
  for (const p of params) {
    if (typeof p !== "string") continue;
    for (const i of levelIndex?.codes[p] ?? []) files.add(i);
    for (const i of levelIndex?.themes[p] ?? []) files.add(i);
  }
  return files.size ? [...files].sort((a, b) => a - b) : [...Array(fileCount).keys()];
}

/** Router for fact queries: call `route(sql, params)` right before running a
 *  query; it repoints each fact view the query reads at the files it needs
 *  (via `exec(sql)`), skipping views already pointing there. Queries must
 *  not run concurrently with a route() call (both engines serialize them).
 *  On a GitHub Pages cache miss the CDN fetches a whole file before
 *  answering, so touching 1-2 small files instead of a level's 27 is what
 *  keeps a cold first query fast. */
export function createFactRouter(manifest, index, src, exec) {
  const current = {}; // level → file set the view points at ("0,4")
  return async function route(sql, params = []) {
    for (const level of factTablesIn(sql)) {
      const files = filesForParams(index?.[level], manifest.facts[level].length, params);
      const key = files.join(",");
      if (current[level] === key) continue;
      await exec(factViewSql(manifest, level, src, files));
      current[level] = key;
    }
  };
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

/** Every view over all files, plus the base tables (Node tools). */
export function schemaStatements(manifest, src) {
  return [...FACT_TABLES.map((l) => factViewSql(manifest, l, src)), ...baseTableStatements(manifest, src)];
}
