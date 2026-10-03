// frontend/src/data/engine.js
//
// Browser data engine: DuckDB-WASM in a Web Worker, reading the Parquet files
// published under <base>/data/ by HTTP range request. Started once, on the
// first API call, and shared by every caller.

import * as duckdb from "@duckdb/duckdb-wasm";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { createApi } from "./routes.js";
import { baseTableStatements, createFactRouter, factTablesIn } from "./schema.js";

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
  const marks = [];
  // Marks are ms since page navigation, so changes that start work before
  // the engine does (e.g. the WASM preload in index.html) show up in them.
  const mark = (label) => marks.push(`${label} ${Math.round(performance.now())}`);
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
  // Which fact files hold each variable (tools/export-data.mjs); without it
  // the router falls back to opening every file of a level.
  const indexReady = manifest.tables.facts_index
    ? fetch(urlOf(manifest.tables.facts_index.file)).then((r) => r.json()).catch(() => null)
    : Promise.resolve(null);
  // Fact files are registered with DuckDB on first use (prepare), not at
  // start-up: there are hundreds, and a query needs one or two.
  const registered = new Set();
  const routerReady = Promise.all([connReady, indexReady]).then(([{ db, conn }, index]) =>
    createFactRouter(manifest, index, regName, (sql) => conn.query(sql), async (files) => {
      for (const file of files.filter((f) => !registered.has(f))) {
        await db.registerFileURL(regName(file), urlOf(file), duckdb.DuckDBDataProtocol.HTTP, false);
        registered.add(file);
      }
    }));
  connReady.catch(() => { apiPromise = null; }); // let the next call retry

  // One connection, one query at a time: the worker executes serially anyway,
  // and a queue keeps prepared statements from interleaving.
  let queue = Promise.resolve();
  let firstFact = false;
  const duckAll = (sql, params = []) => {
    const run = async () => {
      const { conn } = await connReady;
      const route = await routerReady;
      const q0 = performance.now();
      await route(sql, params); // point the fact views at this query's files
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

// The DuckDB WASM module as a blob URL. index.html preloads the file
// (vite.config.js); a worker cannot take over the page's preload, so the
// page reads the preloaded bytes here and hands them to the worker in memory.
// Otherwise the worker downloads its own copy: 8 MB twice, and later.
async function wasmModuleUrl() {
  try {
    const r = await fetch(wasmUrl); // same request as the preload link → reuses it
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bytes = await r.arrayBuffer();
    return { url: URL.createObjectURL(new Blob([bytes], { type: "application/wasm" })), blob: true };
  } catch (err) {
    console.warn("[data] WASM preload unavailable, worker fetches it:", err);
    return { url: wasmUrl, blob: false };
  }
}

async function startDuckDB(manifest, urlOf, mark) {
  const wasm = wasmModuleUrl(); // under way while the worker script loads
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  const { url, blob } = await wasm;
  try {
    await db.instantiate(url);
  } finally {
    if (blob) URL.revokeObjectURL(url);
  }
  mark("wasm");
  // Parquet files are read WHOLE, one request per file, then served from
  // memory for the rest of the session: with the default HTTP settings and
  // GitHub Pages (which ignores Range on HEAD) DuckDB-WASM falls back to full
  // reads. Deliberate: the fact files are small (~3.5 MB) and routed (schema.js),
  // and DuckDB-WASM issues range requests one at a time. Measured 2026-10-03 at
  // 40 ms latency / 10 MB/s: full reads 2 requests, first data 2.5-4.6 s; ranged
  // reads ({ reliableHeadRequests: false, allowFullHTTPReads: true,
  // forceFullHTTPReads: false } via db.open) ~25-30 sequential requests, first
  // data 5.0-5.6 s. Revisit only if the files get much larger.
  // Only the small tables here; fact files are registered on first use.
  const parquet = Object.values(manifest.tables).filter((t) => t.file.endsWith(".parquet"));
  await Promise.all(parquet.map((f) =>
    db.registerFileURL(regName(f.file), urlOf(f.file), duckdb.DuckDBDataProtocol.HTTP, false)));
  mark("register");
  const conn = await db.connect();
  // Keep Parquet footers and HTTP HEAD results between queries. Both caches
  // are off by default, so every fact query re-fetched and re-parsed its
  // file's footer over HTTP (430 KB for csd: 260-500 ms per query).
  // (enable_object_cache, used before, is an old name that no longer does it.)
  for (const setting of ["parquet_metadata_cache", "enable_http_metadata_cache"]) {
    await conn.query(`SET ${setting} = true`).catch((err) => console.warn(`[data] ${setting}:`, err));
  }
  mark("settings");
  for (const sql of baseTableStatements(manifest, regName)) await conn.query(sql);
  mark("duckdb");
  return { db, conn };
}
