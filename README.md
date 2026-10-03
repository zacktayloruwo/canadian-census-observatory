# UNI·CEN Canadian Census Observatory — static (DuckDB-WASM) edition

A serverless port of the Observatory app (`unicen-observatory-js`, the
Express + DuckDB server version). The React frontend is unchanged; the backend
is replaced by DuckDB-WASM running in the browser over static Parquet files,
so the whole site can be hosted on GitHub Pages.

Started from the server version at commit `9bb5619`. That version remains
the reference implementation, and `docs/SPEC.md` and `docs/PERFORMANCE.md`
describe it.

## How it works

```
React app ──fetch("/api/…")──► data/apiFetch.js ──► data/routes.js  (server.js routes, ported)
                                                     │
                       ┌─────────────────────────────┼──────────────────────────┐
                       ▼                             ▼                          ▼
        DuckDB-WASM (Web Worker)          hlook / lineage maps        TopoJSON bundles
        views over facts/*.parquet        (pre-extracted JSON)        (map + geometry routes)
        read by HTTP range request
```

- **`frontend/src/data/routes.js`** — the API routes of `backend/server.js`,
  copied verbatim wherever possible behind a small Express-shaped shim, so the
  two can be diffed. Its header lists every deliberate difference.
- **`frontend/src/data/apiFetch.js`** — a `fetch` stand-in for `/api/*` URLs.
  The components only changed `fetch(` → `apiFetch(`.
- **`frontend/src/data/engine.js`** — starts DuckDB-WASM and loads the lookups
  in parallel. A fact view is created the first time a query uses it, so
  start-up reads only the Parquet footers it needs.
- **`tools/export-data.mjs`** — turns the server's `observatory_v3.duckdb` and
  its sidecars into `frontend/public/data/` (manifest + one versioned
  directory). Fact tables keep only the 9 columns the app reads, are sorted by
  theme/code/year/geosid (so a query touches a couple of 100k-row groups), and
  are split at theme boundaries into files under 50 MB.
- **`tools/compare.mjs`** — runs `routes.js` in Node over the exported files and
  compares ~3,700 responses with the running Express server. They should all
  match, except that `/api/themes?level=4&year=2016` can differ in the order of
  `lnmt`/`lnof`: the server's own order for those two changes between runs.

## Data size (2026-09-12 build)

| | |
|---|---|
| Fact Parquet (ct, csd, cd, cma, pr) | 191 MB in 9 files, largest 40 MB |
| Lookups (hlook, lineage, geos, themes, all_descr) | 22 MB (JSON gzipped by Pages) |
| TopoJSON bundles, 1851–2021 | 124 MB (gzipped by Pages) |
| App + DuckDB-WASM | 37 MB (8 MB gzipped) |
| **Built site** | **≈ 382 MB** (Pages limit: 1 GB) |

## Local development

```bash
cd tools && npm install && node export-data.mjs --src "../../unicen_js/backend/data"
```

```bash
cd frontend && npm install && npm run dev
```

The data is not committed (`frontend/public/data/` is ignored). `frontend/.env`
takes the same `VITE_CARTO_KEY` as the server version.

To check the port against the server version, start the original backend on
port 3001, then:

```bash
cd tools && node compare.mjs
```

## Deploying to GitHub Pages

1. Export the data (above), then publish it as a release asset. This creates
   the release and writes `data-release.txt`:

   ```bash
   tools/publish-data.sh
   ```

2. Commit `data-release.txt` and push to `main`. The workflow in
   `.github/workflows/pages.yml` downloads that release, builds with
   `VITE_BASE=/<repo>/`, and deploys.

In the repo settings, set Pages to **GitHub Actions** and add `VITE_CARTO_KEY`
as a repository secret or variable (Settings → Secrets and variables →
Actions). The build compiles it into the bundle, so a change needs a redeploy. Restrict that key to the Pages domain in CARTO.

Data refreshes go into a new versioned directory and a new release. Open
sessions keep reading the version they started with, and only
`manifest.json` changes.
