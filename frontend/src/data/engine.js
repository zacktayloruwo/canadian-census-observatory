// frontend/src/data/engine.js
//
// Browser data engine: DuckDB-WASM in a Web Worker, reading the Parquet files
// published under <base>/data/ by HTTP range request. Started once, on the
// first API call, and shared by every caller.

import * as duckdb from "@duckdb/duckdb-wasm";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { createApi } from "./routes.js";
import { baseTableStatements, factTablesIn, factViewSql } from "./schema.js";

const DATA_BASE = new URL(`${import.meta.env.BASE_URL}data/`, window.location.href);

// Registered file names must be flat; manifest paths carry a facts/ prefix.
const regName = (file) => file.replaceAll("/", "__");

let apiPromise = null;

/** The ported API ({ handle }), started on first use. */
export function getApi() {
  if (!apiPromise) {
    apiPromise = start().catch((err) => {
      apiPromise = null; // let the next call retry
      throw err;
    });
  }
  return apiPromise;
}

// Arrow table → plain row objects, BIGINTs as numbers (as server.js did).
// Column-wise: Arrow's per-row proxies (table.toArray()[i].toJSON()) took
// ~3 s for the 260k hlook + lineage rows loaded at start-up.
function toRows(table) {
  const n = table.numRows;
  const cols = table.schema.fields.map((f, i) => {
    const vec = table.getChildAt(i);
    const vals = vec.toArray();
    // toArray() gives a typed array for numeric columns, where nulls read as 0.
    const typed = ArrayBuffer.isView(vals);
    return { name: f.name, vec, vals, typed, nulls: vec.nullCount > 0 };
  });
  const rows = new Array(n);
  for (let r = 0; r < n; r++) {
    const out = {};
    for (const c of cols) {
      let v = c.typed && c.nulls && !c.vec.isValid(r) ? null : c.vals[r];
      if (typeof v === "bigint") v = Number(v);
      out[c.name] = v ?? null;
    }
    rows[r] = out;
  }
  return rows;
}

async function start() {
  const t0 = performance.now();
  const marks = [];
  const mark = (label) => marks.push(`${label} ${Math.round(performance.now() - t0)}`);
  // manifest.json is the one file a deploy overwrites; everything else lives
  // under its versioned directory, so revalidate only this.
  const manifest = await fetch(new URL("manifest.json", DATA_BASE), { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`data manifest: HTTP ${r.status}`);
      return r.json();
    });
  const vbase = new URL(`${manifest.version}/`, DATA_BASE);
  const urlOf = (file) => new URL(file, vbase).href;

  // DuckDB start-up (WASM compile, file registration, views) runs in the
  // background; queries wait for it. The lookups createApi() builds need no
  // DuckDB, so they load meanwhile and in-memory routes (search, lineage,
  // level) answer before the engine is up.
  const connReady = startDuckDB(manifest, urlOf, mark);
  connReady.catch(() => { apiPromise = null; }); // let the next call retry

  // One connection, one query at a time: the worker executes serially anyway,
  // and a queue keeps prepared statements from interleaving.
  let queue = Promise.resolve();
  const views = new Set(); // fact views created so far (see factViewSql)
  let firstFact = false;
  const duckAll = (sql, params = []) => {
    const run = async () => {
      const conn = await connReady;
      for (const level of factTablesIn(sql)) {
        if (!views.has(level)) {
          await conn.query(factViewSql(manifest, level, regName));
          views.add(level);
          mark(`view:${level}`);
        }
      }
      const q0 = performance.now();
      let table;
      if (params.length) {
        const stmt = await conn.prepare(sql);
        try {
          table = await stmt.query(...params);
        } finally {
          await stmt.close();
        }
      } else {
        table = await conn.query(sql);
      }
      if (!firstFact && factTablesIn(sql).length) { firstFact = true; mark("first-fact-query"); }
      // Per-query timings, kept for profiling from the console.
      (globalThis.__dataQueries ??= []).push(
        `${Math.round(performance.now() - q0)}ms ${sql.replace(/\s+/g, " ").trim().slice(0, 70)}`);
      return toRows(table);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };

  const readJson = (name) => fetch(urlOf(manifest.tables[name].file)).then((r) => r.json());
  const readTopology = async (year) => {
    const f = manifest.topology[year];
    if (!f) return null;
    const r = await fetch(urlOf(f.file));
    if (!r.ok) throw new Error(`topology ${year}: HTTP ${r.status}`);
    return r.json();
  };

  const api = await createApi({ duckAll, readJson, readTopology, log: (m) => m.startsWith("startup:") && mark(m.slice(8)) });
  mark("lookups");
  connReady.then(() => {
    globalThis.__dataStartup = marks; // for profiling from the console
    console.info(`[data] start-up ms (data ${manifest.version}): ${marks.join(", ")}`);
  });
  return api;
}

async function startDuckDB(manifest, urlOf, mark) {
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(wasmUrl);
  mark("wasm");
  const parquet = [
    ...Object.values(manifest.facts).flat(),
    ...Object.values(manifest.tables).filter((t) => t.file.endsWith(".parquet")),
  ];
  await Promise.all(parquet.map((f) =>
    db.registerFileURL(regName(f.file), urlOf(f.file), duckdb.DuckDBDataProtocol.HTTP, false)));
  const conn = await db.connect();
  // Keep Parquet footers and HTTP HEAD results between queries. Both caches
  // are off by default, so every fact query re-fetched and re-parsed its
  // file's footer over HTTP (430 KB for csd: 260-500 ms per query).
  // (enable_object_cache, used before, is an old name that no longer does it.)
  for (const setting of ["parquet_metadata_cache", "enable_http_metadata_cache"]) {
    await conn.query(`SET ${setting} = true`).catch((err) => console.warn(`[data] ${setting}:`, err));
  }
  for (const sql of baseTableStatements(manifest, regName)) await conn.query(sql);
  mark("duckdb");
  return conn;
}
