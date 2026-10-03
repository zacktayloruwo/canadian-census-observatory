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
 *  Binding a view reads each listed file's footer. With no files it reads
 *  the empty table (see baseTableStatements): no query can match a row. */
export function factViewSql(manifest, level, src, fileIdxs = manifest.facts[level].map((_, i) => i)) {
  if (!fileIdxs.length) return `CREATE OR REPLACE VIEW ${level} AS SELECT * FROM empty_facts`;
  const list = fileIdxs.map((i) => lit(src(manifest.facts[level][i].file))).join(", ");
  return `CREATE OR REPLACE VIEW ${level} AS SELECT * FROM read_parquet([${list}])`;
}

/** The params a query binds after `<column> = ?`, by placeholder position
 *  (the route SQL has no "?" inside string literals). */
function paramsAfter(column, sql, params) {
  const before = sql.split("?").slice(0, -1); // text preceding each placeholder
  const re = new RegExp(`\\b${column}\\s*=\\s*$`, "i");
  return params.filter((_, i) => re.test(before[i] ?? ""));
}

/** Files of a level a query needs, from the variables (`t_code = ?`) and
 *  themes (`t_theme = ?`) it filters on: every fact query in routes.js has
 *  at least one. A theme narrows to the census years it is filtered on
 *  (`time = ?`, themeYears) when that theme has them: variables are mostly
 *  per year, so a large theme opens a few files instead of all of them.
 *  Returns [] when none of those variables or themes exist at this level
 *  (the query cannot match a row), and every file for a query with no such
 *  filter, which is always correct, just slow. */
export function filesForQuery(levelIndex, fileCount, sql, params) {
  const codes = paramsAfter("t_code", sql, params);
  const themes = paramsAfter("t_theme", sql, params);
  if (!levelIndex || (!codes.length && !themes.length)) return [...Array(fileCount).keys()];
  const years = paramsAfter("time", sql, params).map(String);
  const files = new Set();
  const add = (list) => { for (const i of list ?? []) files.add(i); };
  for (const c of codes) add(levelIndex.codes[c]);
  for (const t of themes) {
    const byYear = levelIndex.themeYears?.[t];
    const matched = years.filter((y) => byYear?.[y]);
    if (matched.length) matched.forEach((y) => add(byYear[y]));
    else if (!years.length) add(levelIndex.themes[t]);
  }
  return [...files].sort((a, b) => a - b);
}

/** Router for fact queries: call `route(sql, params)` right before running a
 *  query; it repoints each fact view the query reads at the files it needs
 *  (`prepare(fileNames)` first, e.g. to register them, then `exec(sql)`),
 *  skipping views already pointing there. Queries must not run concurrently
 *  with a route() call (both engines serialize them). On a GitHub Pages
 *  cache miss the CDN fetches a whole file before answering, and DuckDB-WASM
 *  reads these files whole, so opening one or two small files instead of a
 *  level's hundred is what keeps queries fast. */
export function createFactRouter(manifest, index, src, exec, prepare = async () => {}) {
  const current = {}; // level → file set the view points at ("0,4")
  return async function route(sql, params = []) {
    for (const level of factTablesIn(sql)) {
      let files = filesForQuery(index?.[level], manifest.facts[level].length, sql, params);
      if (!files.length && !manifest.fact_schema) files = manifest.facts[level].map((_, i) => i);
      const key = files.join(",");
      if (current[level] === key) continue;
      await prepare(files.map((i) => manifest.facts[level][i].file)); // e.g. register them
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
  const out = [`CREATE OR REPLACE TABLE all_descr AS
    SELECT * EXCLUDE (rid) FROM read_parquet(${lit(src(manifest.tables.all_descr.file))}) ORDER BY rid`];
  // A fact table with no rows, for queries on variables a level doesn't have.
  if (manifest.fact_schema) {
    const cols = manifest.fact_schema.map(([name, type]) => `"${name}" ${type}`).join(", ");
    out.push(`CREATE OR REPLACE TABLE empty_facts (${cols})`);
  }
  return out;
}

/** Every view over all files, plus the base tables (Node tools). */
export function schemaStatements(manifest, src) {
  return [...FACT_TABLES.map((l) => factViewSql(manifest, l, src)), ...baseTableStatements(manifest, src)];
}
