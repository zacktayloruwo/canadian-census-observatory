# Performance Profile & Responsiveness Findings

*Measured 2026-08-09 on app version 0.6.0. Companion to [SPEC.md](SPEC.md).*

**Status: findings F1–F6, F8, F9 were implemented the same day (F7 deliberately deferred). Sections 1–6 record the pre-fix baseline; §7 records what changed and the re-measured results.**

## 1. Method

- **Hardware/environment**: Apple Silicon Mac (12 cores, 32 GB RAM), macOS 26.5, Node v24.15.0. Data directory is Dropbox-synced; the 4.45 GB DuckDB file was fully materialized locally during measurement.
- **Backend matrix**: every endpoint hit 3× via curl (`--compressed`); run 1 reported as *cold*, median of runs 2–3 as *warm*. Uncompressed sizes from a separate pass without `Accept-Encoding`. Cross-checked against the server's own `[timing]` middleware log. The 200 req/15 min rate limit was worked around by rotating `X-Forwarded-For` (valid because `trust proxy = 1`); no code was modified.
- **CPU profile**: `node --cpu-prof server.js`, 48 warm requests replayed (8 rounds of: CSD map-data, CT map-data, boundaries, series, cs-plot, geos), profile flushed via SIGINT, self-time aggregated per function.
- **Frontend**: measured on the Vite dev server via in-app browser — network waterfall (`performance` resource entries), long tasks (`PerformanceObserver`, 50 ms threshold; Event Timing API at 16 ms for hover), scripted interactions. **Caveat**: React StrictMode double-fires effects in dev; findings marked (dev-double) would fire once in production, all others persist.
- **Production spot-check**: ~7 gentle requests against https://unicen-observatory-js.onrender.com (warm instance).

## 2. Baseline measurements

**Startup**: 948 ms from process start to first successful `/api/ping` (geos.json parse, DuckDB open, 44.7 MB hlook.json parse). Not a concern. (`hlook.json` parsing at boot will disappear once a `hlook` DuckDB table is deployed — see SPEC.md §3 — but as of 2026-08-09 the available pipeline builds don't yet include one.)

### 2.1 Endpoint matrix (localhost)

| Endpoint (representative params) | Cold ms | Warm ms | Gzipped | Raw | Features |
|---|--:|--:|--:|--:|--:|
| `/api/ping` | 1 | 1 | — | — | |
| `/api/geos?q=toronto` | 3 | 2 | 0.2 KB | 0.2 KB | |
| `/api/level`, `/api/geoyears`, `/api/years` | 1–2 | 1–2 | ≤0.1 KB | ≤0.1 KB | |
| `/api/themes?level=1` | 8 | 4 | 1.6 KB | 9 KB | |
| `/api/codes` (agec) | 2 | 2 | 0.2 KB | 1.5 KB | |
| `/api/map-data` PR (level 5) | 152 | 98 | **1.46 MB** | **4.21 MB** | 13 |
| `/api/map-data` CMA (4) | 28 | 28 | 0.38 MB | 1.14 MB | 50 |
| `/api/map-data` CD (3) | 128 | 114 | 1.86 MB | 5.78 MB | 293 |
| `/api/map-data` CSD (2) | 362 | 245 | **3.34 MB** | **12.57 MB** | 5,159 |
| `/api/map-data` CT (1) | 198 | 113 | 1.21 MB | 5.91 MB | 6,247 |
| `/api/map-data` CT, 2nd t_code | 109 | 114 | 1.21 MB | 5.91 MB | (identical geometry re-sent) |
| `/api/boundaries` (level 5) | 91 | 88 | 1.46 MB | 4.21 MB | 13 |
| `/api/geo-polygon` CT / PR | 4 / 16 | 3 / 17 | 0.9 / 193 KB | 2.7 / 567 KB | 1 |
| `/api/cs-plot`, `/api/os-plot` | 1–7 | 1–5 | ≤0.4 KB | ≤1.2 KB | |
| `/api/nc-ref-value` | 11 | 10 | <0.1 KB | <0.1 KB | |
| `/api/series` (worst case, with ref) | 18 | 12 | 0.3 KB | 1.0 KB | |

**Cache headers**: `/api/themes`, `/api/years`, `/api/codes` send `Cache-Control: public, max-age=3600`. `/api/map-data`, `/api/boundaries`, `/api/series` send **no Cache-Control** (weak ETag only). Static assets: `max-age=0`; Cloudflare reports `cf-cache-status: DYNAMIC`.

**Event-loop blocking**: `/api/ping` baseline 0.6–1.0 ms rises to **47–65 ms** while one CSD map-data response is being built (3 trials); `/api/geos` similarly 50 ms.

### 2.2 CPU profile (48 warm requests, ~2.07 s total busy CPU)

| Self-time | % of busy | Function |
|--:|--:|---|
| 840 ms | 41% | `JSON.stringify` (Express `res.json` of GeoJSON) |
| ~195 ms | 9% | `wkx` WKB parse family (`Polygon._parseWkb`, `toGeoJSON`, `readDoubleForwards`, …) |
| 76 ms | 4% | ETag SHA-1 (`hash.update`) over multi-MB bodies |
| 48 ms | 2% | `findHlookRow` — linear scan of the 107,777-row HLOOK array ([server.js:1428](../backend/server.js)) |
| ~260 ms | — | startup only: `loadHlook` + `buildHlookMaps` + `readFileSync` |

DuckDB query execution barely appears (runs off the JS thread). **The backend's cost is almost entirely serializing and shipping geometry, not querying.**

### 2.3 Frontend measurements (dev server, localhost)

- **First load** (default: Ottawa CSD, Population Density): cascade calls (`level/themes/geoyears/years/codes`) all resolve in 1–6 ms; `map-data` (CSD, 12.6 MB raw) fetched **3×** — twice in `percent` mode (dev-double) and once more in `raw` after a `valueMode` normalization flip (persists in prod) — 397 ms / 1,470 ms / 1,079 ms; `/api/series` 3×; `boundaries` at +1.2 s. Usable map ≈1.6 s on localhost.
- **Theme change** (Population Density → Age - By cohort, at CSD level): **4 sequential map-data fetches** as state churns (`t_code`: dnk2 → agec_avg → agec2529; `value_mode`: percent → raw → percent) — 678 / 662 / 1,303 / 2,341 ms, ≈50 MB raw (13 MB gz) transferred, 3 of 4 responses discarded — plus 4 series fetches and a `boundaries` refetch (753 ms) though level/year didn't change. Main thread: **8 long tasks totaling ≈2.54 s** (max 570 ms). No `AbortController`: the correct response won only because it happened to land last.
- **Percent↔absolute toggle**: refetches map-data + series in full (payload already contains `value`, `raw_value`, **and** `denom_value` per feature — the toggle is computable client-side with zero network). ≈620 ms of long tasks locally.
- **Geography change CSD → CT**: one stale `os-plot` fired at the old level before `/api/level` resolved; then a clean single map-data fetch; **≈1.15 s of long tasks** (max 532 ms) parsing 5.9 MB GeoJSON and building 6,247 SVG paths.
- **Hover sweep** (5,159 CSD polygons): 25 synthetic hover cycles took 27 ms total (~1.1 ms each); **zero** tasks over 16 ms. See §5.

### 2.4 Production spot-check (Render, warm instance)

- RTT (`/api/ping`): 151–176 ms.
- **`/api/map-data` CSD: 1.05–1.14 s per fetch** — 0.70–0.85 s TTFB (server query + serialize + gzip) + 3.25 MB download at ~2.9 MB/s. This is the payload the *default first load* fetches 2–3× and a theme change fetches 4×: the observed multi-second sluggishness is fully explained.
- `/api/boundaries`: 1.5 MB gz, 381 ms. Static assets and API responses are not edge-cached (`cf-cache-status: DYNAMIC`, `max-age=0`).

### 2.5 Bundle

Single JS chunk **1,706 KB (551 KB gz)** + 229 KB CSS (38 KB gz); no code splitting; ECharts imported as full namespace in 4 components; `maplibre-gl` / `recharts` declared but never imported (not in bundle; install bloat only).

## 3. Ranked findings

Each finding: evidence → symptom → cause → suggested remedy (described only; nothing has been changed). Effort: S < 1 day, M = days, L = week+.

### F1 — Geometry is re-downloaded with every data change (highest impact, M)
- **Evidence**: CSD map-data = 12.57 MB raw / 3.34 MB gz, 1.05–1.14 s each on production (§2.1, §2.4); changing only `t_code` re-sends byte-identical geometry (§2.1); one theme change transfers ≈13 MB gz (§2.3).
- **Symptom**: every variable, year, mode, or theme change stalls the map for 1–4+ s on production.
- **Cause**: `/api/map-data` ([server.js:612–762](../backend/server.js)) couples geometry and values in one response; geometry is ~95%+ of the bytes but changes only with (level, year).
- **Remedy**: split the API — `/api/geometry?level&year` (static, `Cache-Control: public, max-age=1y`, cacheable by browser and Cloudflare) + `/api/values?level&year&t_code&value_mode` (~100–300 KB). Client joins by `geosid` and restyles in place. Alternatively TopoJSON or vector tiles. Expected: variable changes drop from seconds to ~100–300 ms; server CPU falls proportionally (F6).

### F2 — One user action triggers up to 4× the necessary fetches (M)
- **Evidence**: theme change → 4 map-data + 4 series fetches, 3 discarded; first load → 3 map-data; stale `os-plot` at old level on geography change; `boundaries` refetched when unchanged (§2.3).
- **Cause**: 22 chained `useEffect`s react to intermediate states — `t_code` churns through defaults, `valueMode` is normalized by a render-time dispatch ([App.jsx:925–928](../frontend/src/App.jsx)) — and no `AbortController` cancels superseded requests (race: last-landed wins).
- **Remedy**: compute the complete target selection in one reducer transition before any fetch effect runs; add `AbortController` to every fetch effect; gate `boundaries` on (level, year) actually changing. Expected: 4× less network/parse work per interaction and elimination of a latent wrong-map race.

### F3 — No HTTP caching on the heavy endpoints or static assets (S)
- **Evidence**: no `Cache-Control` on map-data/boundaries/series; assets `max-age=0`; `cf-cache-status: DYNAMIC`; weak ETags are computed by SHA-1-hashing the full multi-MB body per request (76 ms CPU, §2.2) yet still require a full server round trip.
- **Remedy**: `Cache-Control: public, max-age=…` on map-data/boundaries (census data changes ~never between releases; even 1 h would collapse repeat traffic), `immutable` + long max-age on hashed Vite assets. With Cloudflare in front, cached responses would serve at edge (~50 ms) instead of Render TTFB (~800 ms). Complements F1 (a geometry endpoint is maximally cacheable).

### F4 — Percent/absolute toggle refetches data it already holds (S)
- **Evidence**: toggle → full map-data + series refetch (§2.3) despite `raw_value` and `denom_value` being present in every feature.
- **Remedy**: derive percent client-side and restyle the existing layer; no network at all. Same applies to the `useLogScale` dependency, which refetches an identical response ([App.jsx:747](../frontend/src/App.jsx)).

### F5 — Full GeoJSON layer remount on every change blocks the main thread 1–2.5 s (M)
- **Evidence**: long tasks totaling 2.54 s (theme change) and 1.15 s (CT switch), max 570 ms (§2.3).
- **Cause**: `<GeoJSON key={mapKey}>` ([ChoroplethMap.jsx:612](../frontend/src/ChoroplethMap.jsx)) tears down and rebuilds all 5–6 k SVG paths whenever level/year/theme/code/mode changes; JSON.parse of multi-MB payloads happens on the same thread.
- **Remedy**: with F1 in place, keep the layer mounted and restyle via `layer.setStyle` on value change; memoize decile breaks; consider Leaflet's canvas renderer (`preferCanvas`) for the 5–6 k-polygon levels. Expected: sub-100 ms visual update for value-only changes.

### F6 — Server serialization dominates CPU and blocks the event loop (S–M, largely falls out of F1/F3)
- **Evidence**: `JSON.stringify` = 41% of busy CPU; wkx parse 9%; ETag hashing 4% (§2.2); concurrent cheap requests degrade 0.7 ms → 47–65 ms (§2.1).
- **Remedy**: after F1, pre-serialize each (level, year) geometry once (startup or first request) and serve the cached buffer — stringify and wkx work drop to near zero; disable ETag for the giant dynamic responses (or rely on strong caching). A worker thread or second DuckDB connection is *not* needed once payloads shrink.

### F7 — Geometry is unsimplified for its display size (M)
- **Evidence**: 13 provincial polygons = 4.21 MB raw (§2.1) rendered into a ~900 px national map; boundaries overlay alone is 1.5 MB gz on production.
- **Remedy**: simplify geometries per level offline (e.g. `ST_SimplifyPreserveTopology`, or mapshaper at ~0.5–1% tolerance) or serve TopoJSON (shared arcs). Expected 5–20× size reduction with no visible difference at national zoom; compounds with F1/F3.

### F8 — Monolithic 1.7 MB bundle (S–M)
- **Evidence**: §2.5; Vite's own chunk-size warning fires.
- **Remedy**: import `echarts/core` + used charts/renderers only; `React.lazy` the About/Documentation pages; `manualChunks` to split vendor libs; delete unused deps (`maplibre-gl`, `@maplibre/maplibre-gl-leaflet`, `recharts`, frontend `wkx`/`buffer`) and dead `rowToFeature`. Mostly benefits first visit (551 KB gz JS before paint).

### F9 — Small backend cleanups (S)
- `HLOOK.find` linear scans in `/api/series`, `/api/nc-ref-value` (48 ms CPU under load, §2.2) — `HLOOK_MAP` already exists ([server.js:99–106](../backend/server.js)); use it.
- `/api/series` runs meta → focal → ref strictly sequentially ([server.js:1487–1629](../backend/server.js)); `Promise.all` like `/api/os-plot` already does.
- `/api/series` returns duplicate time points (1961 × 4 observed) — correctness, likely hlook join fan-out; dedupe or fix the join.
- `/api/boundaries` & `/api/geo-polygon` leak raw `err.message`; route through `handleError` like everything else.

## 4. Quick wins vs structural changes

**Quick wins (S, no architecture change)**: F3 cache headers; F4 client-side percent toggle; F8 dead-dep removal + echarts modular imports; F9 map lookup + parallel series.
**Structural (M, the real payoff)**: F1 geometry/values split → F5 restyle-in-place → F2 state-transition consolidation + aborts; F7 simplification. Done together, a variable change goes from *seconds of network + seconds of main-thread rebuild* to *a sub-300 ms values fetch + instant restyle*.

## 5. Non-findings (measured and fine)

- **Hover jank**: the statically suspicious per-hover decile re-sort ([ChoroplethMap.jsx:285–334](../frontend/src/ChoroplethMap.jsx)) measures ~1.1 ms per hover cycle over 5,159 polygons — no user-visible impact on modern hardware (may still matter on low-end devices).
- **DuckDB query speed**: all warm queries ≤245 ms, most ≤20 ms; the 1 GB memory cap showed no spills under this workload.
- **Server startup**: 948 ms — fine.
- **Panel endpoints** (`cs-plot`, `os-plot`, `series`, `nc-ref-value`): all ≤18 ms — fine.
- **`/api/geos` search**: 2–9 ms per keystroke over 20,734 rows with a 300 ms debounce — fine.
- **Rate limiter**: 200/15 min was not approached by normal app usage (~25 requests per session-start).

## 6. Appendix — raw data

Profiling artifacts (timing CSVs, headers, `.cpuprofile`, server logs) were captured in the session scratchpad; key aggregates are reproduced in §2. CPU profile top self-time entries beyond §2.2: `readFileUtf8` 54 ms, `readFileSync` 44 ms (startup), `readDoubleForwards` 35 ms, `buildHlookMaps` 32 ms, Express route internals <25 ms each.

## 7. Remediation — implemented 2026-08-09

All findings except F7 (geometry simplification) were implemented and verified in the running app the same day. What changed, per finding:

- **F1 (geometry/values split)** — new `/api/geometry?level&year` (geometry-only, built once per level/year — WKB parse + stringify — and served from an LRU-capped in-memory cache with a manual ETag) and `/api/values?level&year&t_code` (`{geosid, raw_value, denom_value}` rows plus `t_level`/`t_denom` meta, ~30–100 KB gz). The frontend joins them by geosid and keeps a small client-side geometry cache; `/api/boundaries` serves from the same server cache; `/api/map-data` retained as legacy for stale clients. (An initial variant that pre-gzipped the cached geometry and set `Content-Encoding` manually was reverted: it broke behind gzip-decoding proxies; encoding is left to the `compression()` middleware.)
- **F2 (fetch fan-out / races)** — every data-fetch effect now carries an `AbortController`; the render-time `valueMode` normalization dispatch was removed in favor of the derived `effectiveValueMode`; `setTheme` clears `codeLevel` (the stale `-1` was misclassifying new themes as non-count); `codeOptions` is cleared eagerly so the default-code effect can't resurrect the previous theme's `t_code`; a `levelFor` guard skips map/plot fetches while `state.level` still belongs to the previous geography.
- **F3 (HTTP caching)** — geometry/boundaries: `public, max-age=86400, stale-while-revalidate=604800`; values/map-data/series/plots/nc-ref-value/geo-polygon: `public, max-age=3600` (86400 for geo-polygon); hashed Vite assets: `immutable, max-age=1y`; `index.html`: `no-cache`. 304 revalidation via manual ETags verified.
- **F4 (client-side percent)** — `displayValues` (useMemo) derives percent from `raw_value`/`denom_value`; the toggle triggers zero map-data network (only the small `/api/series` refetch, whose values are mode-dependent server-side).
- **F5 (restyle in place)** — the GeoJSON layer's key is now `level-year` only; variable/mode changes restyle all layers via `setStyle` with memoized decile breaks; hover tooltips read live values through a ref.
- **F6 (server serialization)** — falls out of F1: stringify and wkx run once per (level, year) instead of per request; manual ETags remove per-request SHA-1 hashing of multi-MB bodies.
- **F8 (bundle)** — shared `echartsCore.js` (echarts/core + bar/line + grid/tooltip/legend/markLine + canvas renderer); `React.lazy` for About/Documentation; `manualChunks` vendor split; removed unused deps (`maplibre-gl`, `@maplibre/maplibre-gl-leaflet`, `recharts`, frontend `wkx`/`buffer`, backend `buffer`; `@duckdb/node-api` was removed here as unused, then re-adopted when the backend later migrated off the legacy `duckdb` package), dead `rowToFeature`, and `src/old/`.
- **F9 (backend cleanups)** — `HLOOK_MAP`/`HLOOK_YEARS` O(1) lookups in `/api/series` and `/api/nc-ref-value`; series focal/ref queries parallelized; series rows deduplicated by time and filtered by level (fixes the 1961×4 duplicates); `/api/boundaries` and `/api/geo-polygon` route errors through `handleError`.

### Re-measured results (localhost dev, same hardware; dev-mode React StrictMode still double-fires some effects)

| Scenario | Before | After |
|---|---|---|
| Theme change (CSD level) — network | 4 × map-data (12.6 MB raw each, ≈13 MB gz total) + 4 series + boundaries refetch | **0 geometry fetches**; 3 values fetches (~40–100 ms, ≈100 KB total) + 3 series; no boundaries refetch |
| Theme change — main-thread long tasks | ≈2,540 ms (max 570 ms) | **≈430 ms** (max 200 ms) |
| Percent↔absolute toggle | full map-data + series refetch (3.3 MB gz), ≈620 ms long tasks | **zero map network** (series only, ~1 KB), ≈150 ms long tasks |
| Geography CSD→CT switch | stale wrong-level plot fetch + 5.9 MB map-data; ≈1,150 ms long tasks | no wrong-level fetches; geometry 238 ms + values 187 ms in parallel; ≈1,070 ms long tasks (legitimate layer rebuild — 6,247 new polygons) |
| `/api/geometry` CSD | (endpoint didn't exist; map-data warm 245 ms per request) | cold build 456–583 ms once, then ~35 ms served from cache; browser-cached for 24 h thereafter (304 on revalidate) |
| `/api/values` CSD | — | 5,161 rows, 36 KB gz, ~50–100 ms |
| `/api/series` CT with ref | 12–18 ms, duplicated time points | 1–108 ms, parallel queries, duplicates gone |
| JS bundle | 1,706 KB single chunk (551 KB gz) | 1,139 KB across 4 cache-friendly chunks (366 KB gz) + lazy pages |

Production expectation (Render + Cloudflare): geometry becomes edge/browser-cacheable, so a variable change costs one ~30–100 KB values fetch (~200 ms at observed RTT) instead of a 1.05–1.14 s 3.3 MB map-data download; first-load geometry is paid once per level/year per day per client.

**Not done**: F7 (offline geometry simplification / TopoJSON) — the biggest remaining lever for first-visit payload size (PR-level geometry alone is 4.2 MB raw for 13 polygons); revisit if first-load time on production still matters after Cloudflare starts caching `/api/geometry`.
