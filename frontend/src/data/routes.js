// frontend/src/data/routes.js
//
// The Express API of the server version (unicen_js/backend/server.js, commit
// 9bb5619), ported to run inside the browser against DuckDB-WASM. The route
// bodies are copied verbatim from server.js wherever possible, behind a tiny
// Express-shaped shim (app.get / req.query / res.status().json()), so the
// two versions can be diffed and kept in step. Edited or rewritten parts:
//
//   - start-up: hlook, lineage, themes (and geos, lazily) come from readJson (hlook and
//     lineage as pre-extracted column-wise JSON), not the fs or DuckDB
//   - /api/themes: ORDER BY added so tied descriptions sort deterministically
//   - geometry (/api/topology, /api/geometry, /api/boundaries,
//     /api/geo-polygon) is cut from the static TopoJSON bundles instead of the
//     WKB geoms table, which is not shipped
//   - dropped: /api/map-data (legacy), /api/topics and /api/ref-options
//     (unused by the frontend), and all HTTP middleware
//
// The module is isomorphic: tools/compare.mjs runs it in Node against the same
// Parquet files through @duckdb/node-api to check it against the live server.
//
// createApi({ duckAll, readJson, readTopology, log? }) → { handle(path, query) }
//   duckAll(sql, params)  → Promise<row objects>, numbers not BigInts
//   readJson(name)        → Promise<parsed JSON: geos | themes | hlook | lineage>
//   readTopology(year)    → Promise<topology object | null>
//   handle(...)           → Promise<{ status, body }>

import { feature as topoFeature } from "topojson-client";

export async function createApi({ duckAll, readJson, readTopology, log = () => {} }) {
  // ── Express-shaped shim ────────────────────────────────────────────────────
  const ROUTES = new Map();
  const app = { get: (p, h) => ROUTES.set(p, h) };

  function handleError(res, err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }

  // ── Start-up data (server.js loaded these from disk / DuckDB) ─────────────
  // hlook and the lineage concordance arrive pre-extracted as column-wise
  // JSON ({ column: [values] }, tools/export-data.mjs); expanded here into the
  // same row objects server.js got from its SELECTs.
  const columnsToRows = (cols) => {
    const names = Object.keys(cols);
    const n = names.length ? cols[names[0]].length : 0;
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = {};
      for (const k of names) row[k] = cols[k][i];
      rows[i] = row;
    }
    return rows;
  };
  log("startup:begin");
  const [THEMES, hlookCols, lineageCols] = await Promise.all(
    ["themes", "hlook", "lineage"].map((name) => readJson(name))
  );
  log("startup:fetched");
  // The search index (geos.json, 4.4 MB) is read on the first /api/geos call,
  // keeping it off the start-up path.
  let geoDataPromise = null;
  const loadGeoData = () => (geoDataPromise ??= readJson("geos").then((rawGeos) => rawGeos.map((row) => ({
    geosid: row.geosid ?? row.id ?? row.t_code ?? row.geo_id ?? row.code,
    label: row.label ?? row.name ?? row.geo_label ?? row.title,
    year_min: row.year_min != null ? Number(row.year_min) : null,
    year_max: row.year_max != null ? Number(row.year_max) : null,
    geouid: row.geouid != null && row.geouid !== "" ? String(row.geouid) : null,
  }))).catch((err) => { geoDataPromise = null; throw err; }));

  let HLOOK       = [];
  let HLOOK_MAP   = new Map();
  let HLOOK_YEARS = new Map();
  {
    const rows = columnsToRows(hlookCols);
    HLOOK = rows;
    for (const row of rows) {
      HLOOK_MAP.set(`${row.year}:${row.geosid}`, row);
      if (!HLOOK_YEARS.has(row.geosid)) HLOOK_YEARS.set(row.geosid, []);
      HLOOK_YEARS.get(row.geosid).push(row.year);
    }
    for (const years of HLOOK_YEARS.values()) years.sort((a, b) => a - b);
  }
  log("startup:hlook");

  const VALID_THEMES = new Set(THEMES.filter((t) => t.weight !== "drop").map((t) => t.t_theme));
  const THEME_BY_ID = new Map(THEMES.map((t) => [t.t_theme, t]));

  // ── lineage, hlook helpers (verbatim, server.js 237-316) ──
  // --- geouid lineage concordance (CSD and CD, 1851-2021) ---
  // census/final/concordance (contract section 5), loaded by data-prep step 13
  // as table geouid_concordance. Before 1981 a geosid is reused for a different
  // place every census, so "same code" is not "same place"; the concordance
  // gives the lineage (geouid) a unit belongs to and its member in every other
  // census. Absent table (v2/legacy DB): the maps stay empty and every caller
  // falls back to the same-code era rule.
  const LINEAGE_BY_KEY  = new Map(); // "level:time:geosid" -> row
  const LINEAGE_MEMBERS = new Map(); // geouid -> [{time, geosid, geoname, status}] sorted by time
  async function loadLineage() {
    // (port: rows from lineage.json instead of the geouid_concordance table)
    const rows = lineageCols ? columnsToRows(lineageCols) : null;
    if (!rows || rows.length === 0) { console.log("No geouid_concordance table — lineage lookups off"); return; }
    for (const r of rows) {
      const row = { level: Number(r.level), time: Number(r.time), geosid: String(r.geosid),
                    geouid: String(r.geouid), status: r.status, geoname: r.geoname };
      LINEAGE_BY_KEY.set(`${row.level}:${row.time}:${row.geosid}`, row);
      if (!LINEAGE_MEMBERS.has(row.geouid)) LINEAGE_MEMBERS.set(row.geouid, []);
      LINEAGE_MEMBERS.get(row.geouid).push(row);
    }
    for (const m of LINEAGE_MEMBERS.values()) m.sort((a, b) => a.time - b.time);
    console.log(`Loaded ${rows.length} lineage rows (${LINEAGE_MEMBERS.size} geouids)`);
  }
  // The lineage a (geosid, year) belongs to, or null. Level comes from hlook
  // when not given (concordance covers csd = 2 and cd = 3 only).
  function lineageFor(geosid, year, level = null) {
    const gStr = String(geosid).trim();
    const y = Number(year);
    // Without a level, take hlook's; a unit-year with data but no boundary
    // (csd 1961/1971 have no polygon layer) has no hlook row, so then try the
    // levels the concordance covers.
    const lv = level != null ? Number(level) : Number(HLOOK_MAP.get(`${y}:${gStr}`)?.level);
    const candidates = lv ? [lv] : [2, 3];
    for (const l of candidates) {
      const row = LINEAGE_BY_KEY.get(`${l}:${y}:${gStr}`);
      if (row) return { ...row, members: LINEAGE_MEMBERS.get(row.geouid) || [] };
    }
    return null;
  }

  function getGeoMeta(year, geosid) {
    return HLOOK_MAP.get(`${year}:${geosid}`) || null;
  }

  // Level 1 (CT) — see the level map at the top of this file.
  const CT_LEVEL = 1;

  // The wider place a geography sits in, for labelling it in a popup.
  //
  // The province is the right context for a municipality or a county, but not
  // for a census tract: a tract's name IS its numeric id, so "5550004.01,
  // Ontario" locates it only to within a thousand kilometres. Tracts exist only
  // inside metropolitan areas, so the CMA is the name that actually places one.
  // Falls back to the province for the handful of tract rows with no CMA on
  // file (35 of 47,624 in the current hlook).
  function contextName(row) {
    if (!row) return null;
    if (Number(row.level) === CT_LEVEL && row.cmaname) return row.cmaname;
    return row.prname || null;
  }

  // geoname plus its context, the form every popup label takes.
  function labelWithContext(row, fallback) {
    if (!row) return fallback == null ? null : String(fallback);
    const geoName = row.geoname || row.geoname_full || null;
    const context = contextName(row);
    if (geoName && context) return `${geoName}, ${context}`;
    if (geoName) return geoName;
    if (context) return context;
    return fallback == null ? String(row.geosid) : String(fallback);
  }

  function getLevelForGeosid(year, geosid, fallbackLevel) {
    const meta = getGeoMeta(year, geosid);
    if (meta && meta.level != null) {
      return Number(meta.level);
    }
    return fallbackLevel;
  }

  // ── lookup routes (verbatim, server.js 401-565) ──
  // --- GEO API: /api/geos?q=searchTerm ---
  app.get("/api/geos", async (req, res) => {
    const GEO_DATA = await loadGeoData(); // (port: loaded lazily)
    const q = (req.query.q || "").toLowerCase().trim();

    let results = GEO_DATA;

    if (q) {
      results = GEO_DATA.filter((row) => {
        const label = (row.label || "").toLowerCase();
        const idStr = String(row.geosid || "").toLowerCase();
        return label.includes(q) || idStr.includes(q);
      });
    }

    // Exact-id matches first: a CD code such as 3506 is a substring of every
    // CSD code in that division, and the 200-row cap would otherwise drop the
    // CD's own entries (the map-click label lookup relies on them).
    if (q) {
      const exact = results.filter((row) => String(row.geosid || "").toLowerCase() === q);
      if (exact.length) results = exact.concat(results.filter((row) => String(row.geosid || "").toLowerCase() !== q));
    }
    // return at most 200 matches
    results = results.slice(0, 200);

    // make sure the API returns consistent structure
    results = results.map((row) => ({
      geosid: row.geosid,
      label: row.label,
      year_min: row.year_min ?? null,
      year_max: row.year_max ?? null,
      geouid: row.geouid ?? null,
    }));

    res.json(results);
  });

  // GET /api/meta?year=&geosid= → geoname + level from HLOOK_MAP (fast, in-memory)
  app.get("/api/meta", (req, res) => {
    const { year, geosid } = req.query;
    if (!year || !geosid) {
      return res.status(400).json({ error: "year and geosid are required" });
    }

    const row = getGeoMeta(Number(year), geosid);
    if (!row) return res.status(404).json({ error: "not found" });

    res.json({
      level: row.level,
      geoname: row.geoname,
    });
  });

  // GET /api/ping → health check
  app.get("/api/ping", (req, res) => {
    res.json({ status: "ok", message: "backend is running" });
  });

  // --- Level API: /api/level?year=YYYY&geosid=... ---
  app.get("/api/level", (req, res) => {
    const year = Number(req.query.year);
    const geosid = req.query.geosid;

    if (!year || !geosid) {
      return res
        .status(400)
        .json({ error: "year and geosid are required" });
    }

    const key = `${year}:${geosid}`;
    const row = HLOOK_MAP.get(key);

    if (!row) {
      return res.status(404).json({
        error: "No level metadata found for this (year, geosid)",
      });
    }

    // Return just what you care about for now
    res.json({
      year: row.year,
      geosid: row.geosid,
      level: row.level,
      geoname: row.geoname,
      prabbr: row.prabbr,
      prname: row.prname,
    });
  });

  // GET /api/ct-cma?year=2021 → { year, names: { <ct geosid>: "<CMA name>" } }
  //
  // Census tracts are the one level whose popups name a metro area rather than a
  // province (see contextName). The map tooltip needs that name for whichever
  // tract the pointer is over, and the polygons it draws come from the static
  // per-year TopoJSON bundles, whose feature properties carry prname only and
  // are produced outside this service. So the whole level's names are served
  // once per year instead — an in-memory filter over HLOOK, ~6k entries that
  // gzip to a few tens of kB, fetched only while the CT level is selected.
  app.get("/api/ct-cma", (req, res) => {
    const year = req.query.year ? Number(req.query.year) : null;
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be a number" });
    }
    const names = {};
    for (const row of HLOOK) {
      if (Number(row.year) !== year) continue;
      if (Number(row.level) !== CT_LEVEL) continue;
      if (row.cmaname) names[String(row.geosid)] = row.cmaname;
    }
    res.set("Cache-Control", "public, max-age=3600, must-revalidate");
    res.json({ year, names });
  });

  // GET /api/geoyears?geosid=... → sorted years where this geosid exists in hlook
  // The years in which a geosid names the SAME place as it does in `year`.
  // From 1976 on StatCan codes persist, so that is one era (only spellings
  // change). Before that a code is a per-census sequence — CSD 3506008 is
  // St. Edmunds in 1911 and Ottawa from 2001 — so an era is the run of
  // consecutive censuses carrying the same normalised name. Mirrors the search
  // list's per-era entries (data-prep 04_hlook_v3.R). Without a year, or with
  // a year the code does not exist in, every year is returned (legacy rule).
  function normName(g) {
    return String(g ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function eraYears(geosid, year) {
    const gStr = String(geosid).trim();
    const years = HLOOK_YEARS.get(gStr) || [];
    const y = Number(year);
    if (!years.length || !Number.isFinite(y) || !years.includes(y)) return years;
    if (y >= 1976) return years.filter((t) => t >= 1976);
    const nameAt = (t) => normName(HLOOK_MAP.get(`${t}:${gStr}`)?.geoname);
    const target = nameAt(y);
    const early = years.filter((t) => t < 1976);
    const i = early.indexOf(y);
    let lo = i, hi = i;
    while (lo > 0 && nameAt(early[lo - 1]) === target) lo--;
    while (hi < early.length - 1 && nameAt(early[hi + 1]) === target) hi++;
    return early.slice(lo, hi + 1);
  }

  // GET /api/geoyears?geosid=...&year=... → years where this geosid names the
  // same place as in `year` (see eraYears); all years when `year` is omitted.
  app.get("/api/geoyears", (req, res) => {
    const { geosid } = req.query;
    if (!geosid) return res.status(400).json({ error: "geosid is required" });
    const year = req.query.year ? Number(req.query.year) : null;
    const lin = year ? lineageFor(geosid, year, req.query.level || null) : null;
    if (lin) return res.json(lin.members.map((m) => m.time));
    res.json(eraYears(geosid, year));
  });

  // GET /api/lineage?geosid=&year=[&level=] → the geouid lineage this unit
  // belongs to in `year`: {geouid, status, first_year, last_year, members:[{time,
  // geosid, geoname, status}]}; 404 when the concordance has no row for it.
  app.get("/api/lineage", (req, res) => {
    const { geosid } = req.query;
    const year = req.query.year ? Number(req.query.year) : null;
    if (!geosid || !year) return res.status(400).json({ error: "geosid and year are required" });
    const lin = lineageFor(geosid, year, req.query.level || null);
    if (!lin) return res.status(404).json({ error: "no lineage for this unit" });
    const members = lin.members.map((m) => ({ time: m.time, geosid: m.geosid, geoname: m.geoname, status: m.status }));
    res.set("Cache-Control", "no-cache");
    res.json({ geouid: lin.geouid, level: lin.level, status: lin.status,
               first_year: members[0]?.time ?? null, last_year: members[members.length - 1]?.time ?? null,
               members });
  });

  // ── catalogue routes (verbatim, server.js 606-883) ──
  const LEVEL_CODE = {
    1: "ct",
    2: "csd",
    3: "cd",
    4: "cma",
    5: "pr",
  };

  // GET /api/themes?level=4&year=2021
  // Returns distinct themes for this level + year
  app.get("/api/themes", async (req, res) => {
    const levelNum = Number(req.query.level);
    const year = req.query.year ? Number(req.query.year) : 2021;

    if (!levelNum) {
      return res.status(400).json({ error: "level is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year must be a valid number" });
    }

    const levelStr = LEVEL_CODE[levelNum];
    if (!levelStr) {
      return res
        .status(400)
        .json({ error: `No level code configured for level ${levelNum}` });
    }

    const sql = `
      SELECT DISTINCT t_theme, t_themedescr, t_type
      FROM all_descr
      WHERE level = ?
        AND time  = ?
        AND t_theme IS NOT NULL
      ORDER BY t_theme
    `;
    // ORDER BY added in the port: themes sharing a description (lnmt and lnof
    // in 2016) otherwise tie in the sort below in whatever order DISTINCT
    // produced, which differed between runs.

    log("[themes] levelNum:", levelNum, "levelStr:", levelStr, "year:", year);

    try {
      const rows = await duckAll(sql, [levelStr, year]);

      let themes = rows;

      // Optional: still enforce VALID_THEMES from themes.json
      if (typeof VALID_THEMES !== "undefined") {
        themes = rows
          .filter((r) => VALID_THEMES.has(r.t_theme))
          .sort((a, b) =>
            a.t_themedescr.localeCompare(b.t_themedescr, "en", {
              sensitivity: "base",
            })
          );
      } else {
        themes = rows.sort((a, b) =>
          a.t_themedescr.localeCompare(b.t_themedescr, "en", {
            sensitivity: "base",
          })
        );
      }

      // Dedupe by t_theme: all_descr can carry two different descriptions under
      // one theme code (e.g. "lnof" in 2016 is both "First Language (Mother
      // Tongue)" and "First Official Language Spoken"), and duplicate option
      // values hard-crash the frontend's Select. Keep the first, warn upstream.
      const seenThemes = new Set();
      themes = themes.filter((t) => {
        if (seenThemes.has(t.t_theme)) {
          console.warn(`[themes] duplicate t_theme "${t.t_theme}" in all_descr for level=${levelStr} time=${year} — upstream data issue, keeping first row`);
          return false;
        }
        seenThemes.add(t.t_theme);
        return true;
      });

      log("[themes] found", themes.length, "themes");
      res.set("Cache-Control", "no-cache");
      res.json(themes);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/years?level=4&t_theme=dnk2
  app.get("/api/years", async (req, res) => {
    const levelNum = Number(req.query.level);
    const t_theme = req.query.t_theme;

    if (!levelNum) {
      return res.status(400).json({ error: "level is required" });
    }
    if (!t_theme) {
      return res.status(400).json({ error: "t_theme is required" });
    }

    const levelStr = LEVEL_CODE[levelNum];
    if (!levelStr) {
      return res
        .status(400)
        .json({ error: `No level code configured for level ${levelNum}` });
    }

    const sql = `
      SELECT DISTINCT time
      FROM all_descr
      WHERE level   = ?
        AND t_theme = ?
      ORDER BY time
    `;

    log("[years] levelNum:", levelNum, "levelStr:", levelStr, "t_theme:", t_theme);

    try {
      const rows = await duckAll(sql, [levelStr, t_theme]);

      log("[years] raw rows:", rows);

      const years = rows
        .map((r) => r.time)
        .filter((y) => y != null)
        .sort((a, b) => a - b);

      log("[years] final years:", years);
      res.set("Cache-Control", "no-cache");
      res.json(years);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/code-levels?t_code=dnk2&year=2021
  // Which geography levels carry THIS variable in THIS year. Drives the Level
  // control in the selector panel: only these levels are enabled, so switching
  // level never loses the current variable or year.
  app.get("/api/code-levels", async (req, res) => {
    const t_code = req.query.t_code;
    const year = req.query.year ? Number(req.query.year) : null;
    if (!t_code) return res.status(400).json({ error: "t_code is required" });
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be a number" });
    }
    const sql = `
      SELECT DISTINCT level
      FROM all_descr
      WHERE t_code = ?
        AND time   = ?
    `;
    try {
      const rows = await duckAll(sql, [t_code, year]);
      const byStr = Object.fromEntries(Object.entries(LEVEL_CODE).map(([n, s]) => [s, Number(n)]));
      const levels = rows
        .map((r) => byStr[String(r.level)])
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
      log("[code-levels]", t_code, year, "->", levels);
      res.set("Cache-Control", "no-cache");
      res.json({ levels });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/code-years?level=2&t_code=dnk2
  // Which census years carry THIS variable, and which census years exist at all
  // for this level. The year pulldown's coverage strip needs both: the second is
  // the backdrop, the first is what is selectable.
  //
  // Deliberately not driven by a hardcoded 1851..2026 list — `census` is derived,
  // so a new census year appears in the UI as soon as it appears in the data.
  app.get("/api/code-years", async (req, res) => {
    const levelNum = Number(req.query.level);
    const t_code = req.query.t_code;

    if (!levelNum) {
      return res.status(400).json({ error: "level is required" });
    }
    if (!t_code) {
      return res.status(400).json({ error: "t_code is required" });
    }

    const levelStr = LEVEL_CODE[levelNum];
    if (!levelStr) {
      return res
        .status(400)
        .json({ error: `No level code configured for level ${levelNum}` });
    }

    const censusSql = `
      SELECT DISTINCT time
      FROM all_descr
      WHERE level = ?
      ORDER BY time
    `;
    const availableSql = `
      SELECT DISTINCT time
      FROM all_descr
      WHERE level  = ?
        AND t_code = ?
      ORDER BY time
    `;

    log("[code-years] levelNum:", levelNum, "levelStr:", levelStr, "t_code:", t_code);

    try {
      const [censusRows, availableRows] = await Promise.all([
        duckAll(censusSql, [levelStr]),
        duckAll(availableSql, [levelStr, t_code]),
      ]);

      const toYears = (rows) =>
        rows.map((r) => r.time).filter((y) => y != null).map(Number).sort((a, b) => a - b);

      const census = toYears(censusRows);
      const available = toYears(availableRows);

      log("[code-years]", available.length, "of", census.length, "years carry", t_code);
      res.set("Cache-Control", "no-cache");
      res.json({ census, available });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/codes?level=4&t_theme=dnk2&year=2021
  // Returns distinct t_code / t_name for this level + theme + year
  app.get("/api/codes", async (req, res) => {
    const levelNum = Number(req.query.level);
    const t_theme = req.query.t_theme;
    const year = req.query.year ? Number(req.query.year) : null;

    if (!levelNum) {
      return res.status(400).json({ error: "level is required" });
    }
    if (!t_theme) {
      return res.status(400).json({ error: "t_theme is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({
        error: "year is required and must be a number",
      });
    }

    const levelStr = LEVEL_CODE[levelNum];
    if (!levelStr) {
      return res.status(400).json({
        error: `No level code configured for level ${levelNum}`,
      });
    }

    const sql = `
      SELECT
        t_code,
        t_name,
        t_level
      FROM all_descr
      WHERE level   = ?
        AND t_theme = ?
        AND time    = ?
        AND t_code IS NOT NULL
        AND t_level IN (1, -1)
      ORDER BY rowid
    `;

    log("[codes] params:", { levelNum, levelStr, t_theme, year });

    if (t_theme && !VALID_THEMES.has(t_theme)) {
      return res.status(400).json({ error: "Invalid t_theme" });
    }

    try {
      const rows = await duckAll(sql, [levelStr, t_theme, year]);

      log("[codes] returning", rows.length, "codes in data order");
      res.set("Cache-Control", "no-cache");
      res.json(rows);
    } catch (err) {
      handleError(res, err);
    }
  });

  // (verbatim, server.js 962-979)
  // Every fact-table query reads only loc = 't' (total) rows: 1921-1961 tables
  // also carry urban / rural (u, rt, rf, rn) breakdowns of the same unit, and
  // summing or joining across them inflated values (Halifax CD 1961, English
  // mother tongue, showed 3000 %). Project-lead decision 2026-09-08.
  // Data responses are sent with Cache-Control: no-cache, i.e. the browser
  // keeps them but revalidates every time against the ETag Express derives
  // from the body (a 304 when nothing changed). They used to carry
  // max-age=3600, which kept a rebuilt database's old numbers on screen for an
  // hour after a deploy (Halifax CD 1961 stayed at 3000 % after the loc fix).
  // Level number → fact table name (used in SQL FROM clauses) and level string
  // (used as the `level` column value in all_descr). Both maps use the same keys.
  const DATA_TABLE = {
    1: "ct",
    2: "csd",
    3: "cd",
    4: "cma",
    5: "pr",
  };

  // ── Geometry from the static TopoJSON bundles (rewritten) ─────────────────
  // server.js built /api/geometry, /api/boundaries and /api/geo-polygon from
  // WKB in the geoms table. The per-year bundles carry the same features
  // (same pipeline output, properties geosid/geoname/prname + flags), so the
  // static version cuts all three from the bundle.
  const TOPOLOGY_CACHE = new Map(); // year → Promise<topology | null>
  function getTopology(year) {
    if (!TOPOLOGY_CACHE.has(year)) {
      const p = readTopology(year).catch((err) => {
        TOPOLOGY_CACHE.delete(year); // don't cache transient failures
        throw err;
      });
      TOPOLOGY_CACHE.set(year, p);
      while (TOPOLOGY_CACHE.size > 4) TOPOLOGY_CACHE.delete(TOPOLOGY_CACHE.keys().next().value);
    }
    return TOPOLOGY_CACHE.get(year);
  }

  async function levelCollection(levelNum, year) {
    const topo = await getTopology(year);
    const obj = topo?.objects?.[LEVEL_CODE[levelNum]];
    if (!obj) return { type: "FeatureCollection", features: [] };
    return topoFeature(topo, obj);
  }

  // GET /api/topology?year=2021
  app.get("/api/topology", (req, res) => {
    const year = req.query.year ? Number(req.query.year) : null;
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be a number" });
    }
    getTopology(year)
      .then((topo) => topo
        ? res.json(topo)
        : res.status(404).json({ error: "no topology bundle for this year" }))
      .catch((err) => handleError(res, err));
  });

  // GET /api/geometry?level=2&year=2021
  app.get("/api/geometry", (req, res) => {
    const levelNum = Number(req.query.level);
    const year = req.query.year ? Number(req.query.year) : null;
    if (!levelNum || !DATA_TABLE[levelNum]) {
      return res.status(400).json({ error: "valid level (1-5) is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be a number" });
    }
    levelCollection(levelNum, year).then((fc) => res.json(fc)).catch((err) => handleError(res, err));
  });

  // GET /api/boundaries?level=5&year=2021
  app.get("/api/boundaries", (req, res) => {
    const levelNum = Number(req.query.level) || 5;
    const year     = req.query.year ? Number(req.query.year) : null;
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required" });
    }
    levelCollection(levelNum, year).then((fc) => res.json(fc)).catch((err) => handleError(res, err));
  });

  // GET /api/geo-polygon?geosid=35&year=2021
  // Year resolution as in server.js: the requested year if hlook has the unit
  // then, else the nearest year it exists.
  app.get("/api/geo-polygon", async (req, res) => {
    const geosid  = String(req.query.geosid  ?? "").trim();
    const yearReq = req.query.year ? Number(req.query.year) : null;

    if (!geosid)                      return res.status(400).json({ error: "geosid is required" });
    if (!yearReq || Number.isNaN(yearReq)) return res.status(400).json({ error: "year is required" });

    const geosidYears = HLOOK_YEARS.get(geosid) ?? [];
    let resolvedYear = yearReq;
    if (geosidYears.length > 0 && !geosidYears.includes(yearReq)) {
      resolvedYear = geosidYears.reduce((prev, cur) =>
        Math.abs(cur - yearReq) < Math.abs(prev - yearReq) ? cur : prev
      );
    }

    try {
      const topo = await getTopology(resolvedYear);
      for (const obj of Object.values(topo?.objects ?? {})) {
        const geom = obj.geometries?.find((g) => String(g.properties?.geosid) === geosid);
        if (!geom) continue;
        const meta = getGeoMeta(resolvedYear, geosid);
        return res.json({
          type: "Feature",
          properties: { geosid, geoname: meta?.geoname ?? null },
          geometry: topoFeature(topo, geom).geometry,
        });
      }
      return res.status(404).json({ error: "not found" });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── data routes (verbatim, server.js 1147-1223, 1383-1757, 1838-2214) ──
  // GET /api/values?level=2&year=2021&t_code=agec0004
  // Data values only (no geometry) for a whole level/year/t_code: raw value and
  // denominator value per geosid.  The client computes percent locally from
  // raw/denom, so the percent/absolute toggle needs no round trip at all.
  app.get("/api/values", async (req, res) => {
    const levelNum = Number(req.query.level);
    const year = req.query.year ? Number(req.query.year) : null;
    const t_code = req.query.t_code;

    if (!levelNum || !DATA_TABLE[levelNum]) {
      return res.status(400).json({ error: "valid level (1-5) is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be a number" });
    }
    if (!t_code) {
      return res.status(400).json({ error: "t_code is required" });
    }

    const factTable = DATA_TABLE[levelNum];

    try {
      const metaRows = await duckAll(
        `SELECT t_level, t_denom FROM ${factTable} WHERE t_code = ? AND time = ? AND level = ? LIMIT 1`,
        [t_code, year, levelNum]
      );
      const meta = metaRows[0] || {};
      // t_denom uses sentinel strings ("noncount", "") for variables with no
      // real denominator — normalize those to null so we skip the join and the
      // client never tries to compute a percent from them.
      const rawDenom = meta.t_denom ?? null;
      const denomCode =
        rawDenom && rawDenom !== "noncount" && Number(meta.t_level) === 1
          ? rawDenom
          : null;

      let sql, params;
      if (denomCode) {
        sql = `
          SELECT num.geosid, num.val_t AS raw_value, denom.val_t AS denom_value
          FROM ${factTable} AS num
          LEFT JOIN ${factTable} AS denom
            ON num.geosid = denom.geosid
           AND num.time   = denom.time
           AND num.level  = denom.level
           AND denom.t_code = ?
           AND denom.loc = 't'
          WHERE num.t_code = ? AND num.time = ? AND num.level = ? AND num.loc = 't'
        `;
        params = [denomCode, t_code, year, levelNum];
      } else {
        sql = `
          SELECT geosid, val_t AS raw_value
          FROM ${factTable}
          WHERE t_code = ? AND time = ? AND level = ? AND loc = 't'
        `;
        params = [t_code, year, levelNum];
      }

      const rows = await duckAll(sql, params);
      res.set("Cache-Control", "no-cache");
      res.json({
        t_code,
        level: levelNum,
        year,
        t_level: meta.t_level ?? null,
        t_denom: denomCode,
        rows: rows.map((r) => ({
          geosid: r.geosid,
          raw_value: r.raw_value ?? null,
          denom_value: r.denom_value ?? null,
        })),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  async function computeCatDistribution({
    levelNum,
    year,
    t_theme,
    geosid,
  }) {
    const levelStr = LEVEL_CODE[levelNum];
    if (!levelStr) {
      throw new Error(`Unknown level number: ${levelNum}`);
    }

    // fact tables are named the same as levelStr: ct, csd, cd, cma, pr
    const factTable = levelStr;

    // We only need t_level in (0,1): 0 = denominator, 1 = category cells
  const sql = `
    SELECT
      f.geosid,
      f.t_code,
      f.t_level,
      SUM(f.val_t) AS val_t,
      d.t_name
    FROM ${factTable} AS f
    JOIN all_descr AS d
      ON f.t_code = d.t_code
     AND d.level  = ?
     AND d.time   = ?
     AND d.t_theme = ?
    WHERE f.time   = ?
      AND f.level  = ?
      AND f.geosid = ?
      AND f.loc    = 't'
      AND f.t_level IN (0, 1)
    GROUP BY
      f.geosid, f.t_code, f.t_level, d.t_name, d.rowid
    ORDER BY
      d.rowid
  `;

    const rows = await duckAll(sql, [
      levelStr,
      year,
      t_theme,
      year,
      levelNum,
      geosid,
    ]);

    if (!rows.length) {
      return { total: 0, categories: [] };
    }

    const denomRows = rows.filter((r) => Number(r.t_level) === 0);
    const catRows = rows.filter((r) => Number(r.t_level) === 1);

    let total = denomRows.reduce(
      (sum, r) => sum + Number(r.val_t ?? 0),
      0
    );

    // Fallback if no explicit denominator row: sum of categories
    if (!total || !Number.isFinite(total) || total <= 0) {
      total = catRows.reduce(
        (sum, r) => sum + Number(r.val_t ?? 0),
        0
      );
    }

    if (!total || total <= 0 || !catRows.length) {
      return { total: 0, categories: [] };
    }

    const categories = catRows
      .map((r) => {
        const val = Number(r.val_t ?? 0);
        const pct = (val / total) * 100;
        return {
          t_code: r.t_code,
          t_name: r.t_name || r.t_code,
          val_t: val,
          pct,
        };
      })
      .sort((a, b) => b.pct - a.pct);

    return { total, categories };
  }

  // GET /api/cs-plot
  // Query params:
  //   level      (number, focal level)
  //   year       (number)
  //   t_theme    (string)
  //   geosid     (string, focal geo)
  //   ref_geosid (string, optional reference geo)
  //
  // Returns a focal vs reference categorical breakdown for t_theme
  app.get("/api/cs-plot", async (req, res) => {
    const levelNum = Number(req.query.level);
    const year = req.query.year ? Number(req.query.year) : null;
    const t_theme = req.query.t_theme;
    const geosid = req.query.geosid;
    const refGeosid = req.query.ref_geosid || null;

    if (!levelNum) {
      return res.status(400).json({ error: "level is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res
        .status(400)
        .json({ error: "year is required and must be a number" });
    }
    if (!t_theme) {
      return res.status(400).json({ error: "t_theme is required" });
    }
    if (!geosid) {
      return res.status(400).json({ error: "geosid (focal) is required" });
    }

    // Look up t_type from THEMES; we only support cat/catm here
    const themeMeta = THEMES.find((t) => t.t_theme === t_theme) || null;
    const t_type = themeMeta?.t_type || null;

    if (!t_type || (t_type !== "cat" && t_type !== "catm")) {
      // Graceful "not supported" response
      return res.json({
        supported: false,
        type: t_type || null,
        message: "Only cat/catm variables are supported by /api/cs-plot for now.",
      });
    }

    try {
      // Focal distribution
      const focalDist = await computeCatDistribution({
        levelNum,
        year,
        t_theme,
        geosid,
      });

      if (!focalDist.categories.length) {
        return res.status(404).json({
          supported: true,
          type: "cat",
          error: "No focal data found for that combination.",
        });
      }

      // Reference: if ref_geosid provided, infer its level from HLOOK
      let refLevelNum = null;
      if (refGeosid) {
        refLevelNum = getLevelForGeosid(year, refGeosid, levelNum);
      }

      let refDist = null;
      if (refGeosid && refLevelNum) {
        refDist = await computeCatDistribution({
          levelNum: refLevelNum,
          year,
          t_theme,
          geosid: refGeosid,
        });
      }

      // Merge focal + ref categories
      const focalMap = new Map(
        focalDist.categories.map((c) => [c.t_code, c])
      );
      const refMap = refDist
        ? new Map(refDist.categories.map((c) => [c.t_code, c]))
        : new Map();

      const allCodes = new Set([
        ...Array.from(focalMap.keys()),
        ...Array.from(refMap.keys()),
      ]);

      let categories = [];
      for (const code of allCodes) {
        const f = focalMap.get(code) || {};
        const r = refMap.get(code) || {};
        const t_name = f.t_name || r.t_name || code;
        const focal_pct =
          typeof f.pct === "number" ? f.pct : null;
        const ref_pct =
          typeof r.pct === "number" ? r.pct : null;

        categories.push({
          t_code: code,
          t_name,
          focal_pct,
          ref_pct,
        });
      }

      // Sort by focal percentage (descending)
      categories.sort(
        (a, b) => (b.focal_pct || 0) - (a.focal_pct || 0)
      );

      // Optional: collapse into top K + "Other"
      const MAX_GROUPS = 6;
      if (categories.length > MAX_GROUPS) {
        const main = categories.slice(0, MAX_GROUPS - 1);
        const rest = categories.slice(MAX_GROUPS - 1);

        const otherFocal = rest.reduce(
          (sum, c) => sum + (c.focal_pct || 0),
          0
        );
        const otherRef = rest.reduce(
          (sum, c) => sum + (c.ref_pct || 0),
          0
        );

        main.push({
          t_code: "__OTHER__",
          t_name: "Other",
          focal_pct: otherFocal || null,
          ref_pct: otherRef || null,
        });

        categories = main;
      }

      // Label focal + ref from hlook
      const focalMeta = getGeoMeta(year, geosid);
      const refMeta = refGeosid ? getGeoMeta(year, refGeosid) : null;

      const focalLabel = labelWithContext(focalMeta, geosid);
      const refLabel = labelWithContext(refMeta, refGeosid);

      const themeLabel =
        themeMeta?.t_themedescr || t_theme;

      res.set("Cache-Control", "no-cache");
      return res.json({
        supported: true,
        type: "cat",
        t_theme,
        themeLabel,
        t_type,
        level: levelNum,
        year,
        focal: {
          geosid,
          label: focalLabel,
        },
        ref: refGeosid
          ? {
              geosid: refGeosid,
              level: refLevelNum,
              label: refLabel,
            }
          : null,
        categories,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/os-plot?level=4&year=2021&t_theme=agec&geosid=5550000.00&ref_geosid=35
  // Returns { categories: [labels], focal: [pct], ref: [pct] }
  app.get("/api/os-plot", async (req, res) => {
    const levelNum = Number(req.query.level);
    const year = Number(req.query.year);
    const t_theme = req.query.t_theme;
    const geosid = req.query.geosid;
    const refGeosid = req.query.ref_geosid || null;

    if (!levelNum || Number.isNaN(levelNum)) {
      return res.status(400).json({ error: "level is required and must be numeric" });
    }
    if (!year || Number.isNaN(year)) {
      return res.status(400).json({ error: "year is required and must be numeric" });
    }
    if (!t_theme) {
      return res.status(400).json({ error: "t_theme is required" });
    }
    if (!geosid) {
      return res.status(400).json({ error: "geosid (focal) is required" });
    }

    // Only handle ord/ordc themes
    const themeMeta = THEMES.find((t) => t.t_theme === t_theme);
    const t_type = themeMeta?.t_type ?? null;
    if (t_type !== "ord" && t_type !== "ordc") {
      return res.json({ categories: [], focal: [], ref: [] });
    }

    const factTableFocal = DATA_TABLE[levelNum];
    const levelStrFocal = LEVEL_CODE[levelNum];
    if (!factTableFocal || !levelStrFocal) {
      return res.status(400).json({
        error: `No data table / level code configured for level ${levelNum}`,
      });
    }

    // Compute percentages from raw DB rows (t_level 0 = denom, 1 = category)
    function computeOrdinalDist(rows) {
      if (!rows || rows.length === 0) return [];
      const cats = rows.filter((r) => r.t_level === 1 || r.t_level === "1");
      const totalRow = rows.find((r) => r.t_level === 0 || r.t_level === "0");
      let denom = totalRow?.val_t != null
        ? Number(totalRow.val_t)
        : cats.reduce((acc, r) => acc + (Number(r.val_t) || 0), 0);
      if (!Number.isFinite(denom) || denom <= 0) denom = null;
      return cats
        .map((r) => ({
          t_code: r.t_code,
          t_name: r.t_name,
          rowid: Number(r.rowid) || 0,
          pct: denom && Number.isFinite(Number(r.val_t))
            ? (Number(r.val_t) * 100.0) / denom
            : null,
        }))
        .sort((a, b) => a.rowid - b.rowid);
    }

    // SQL for one geosid; factTable is interpolated from the hardcoded DATA_TABLE enum (safe)
    function buildSql(factTable) {
      return `
        SELECT f.geosid, f.t_code, f.t_level, SUM(f.val_t) AS val_t, d.t_name, d.rowid
        FROM ${factTable} AS f
        JOIN all_descr AS d
          ON f.t_code = d.t_code AND d.level = ? AND d.time = ? AND d.t_theme = ?
        WHERE f.time = ? AND f.level = ? AND f.geosid = ? AND f.loc = 't' AND f.t_level IN (0, 1)
        GROUP BY f.geosid, f.t_code, f.t_level, d.t_name, d.rowid
        ORDER BY d.rowid;
      `;
    }

    try {
      // Resolve ref level from HLOOK before launching queries
      let refLevelNum = null, factTableRef = null, levelStrRef = null;
      if (refGeosid) {
        const refMeta = getGeoMeta(year, refGeosid);
        refLevelNum = refMeta?.level ?? levelNum;
        factTableRef = DATA_TABLE[refLevelNum];
        levelStrRef = LEVEL_CODE[refLevelNum];
      }

      // Run focal and ref queries in parallel when both are needed
      const focalPromise = duckAll(buildSql(factTableFocal), [
        levelStrFocal, year, t_theme, year, levelNum, geosid,
      ]);
      const refPromise = refGeosid && factTableRef
        ? duckAll(buildSql(factTableRef), [levelStrRef, year, t_theme, year, refLevelNum, refGeosid])
        : Promise.resolve([]);

      const [rowsF, rowsR] = await Promise.all([focalPromise, refPromise]);

      const focalDist = computeOrdinalDist(rowsF);
      const refDist = computeOrdinalDist(rowsR);
      const refMap = new Map(refDist.map((r) => [r.t_code, r]));

      const merged = focalDist
        .map((f) => {
          const r = refMap.get(f.t_code);
          return { t_code: f.t_code, t_name: f.t_name, rowid: f.rowid, focal_pct: f.pct, ref_pct: r?.pct ?? null };
        })
        .sort((a, b) => a.rowid - b.rowid);

      res.set("Cache-Control", "no-cache");
      res.json({
        categories: merged.map((d) => d.t_name),
        focal: merged.map((d) => d.focal_pct ?? 0),
        ref: merged.map((d) => d.ref_pct ?? 0),
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/nc-ref-value?geosid=35&year=2021&t_code=dnk2&value_mode=raw|percent
  app.get("/api/nc-ref-value", async (req, res) => {
    const geosid = req.query.geosid;
    const year = req.query.year ? Number(req.query.year) : null;
    const t_code = req.query.t_code;
    const value_mode = req.query.value_mode || "raw";

    if (!geosid) {
      return res.status(400).json({ error: "geosid is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res
        .status(400)
        .json({ error: "year is required and must be a number" });
    }
    if (!t_code) {
      return res.status(400).json({ error: "t_code is required" });
    }

    // ---- FIND REF ROW IN HLOOK ----
    // O(1) lookup via HLOOK_MAP (keyed "year:geosid") instead of scanning the
    // full 100k-row HLOOK array.
    const geosidStr = String(geosid).trim();
    const hrow = HLOOK_MAP.get(`${year}:${geosidStr}`) ?? null;

    if (!hrow) {
      console.warn("[nc-ref-value] No HLOOK row for", { geosid, year });
      return res
        .status(404)
        .json({ error: "No metadata for ref geosid/year" });
    }

    const levelNum = Number(hrow.level);
    if (!levelNum) {
      return res
        .status(400)
        .json({ error: `HLOOK has no numeric level for ref geosid` });
    }

    // You already have this mapping somewhere for map-data/themes/codes.
    // If not, define it at top-level:
    // const DATA_TABLE = { 1: "ct", 2: "csd", 3: "cd", 4: "cma", 5: "pr" };
    const factTable = DATA_TABLE[levelNum];
    if (!factTable) {
      return res
        .status(400)
        .json({ error: `No data table configured for ref level ${levelNum}` });
    }

    log("[nc-ref-value] geosid:", geosid, "year:", year, "t_code:", t_code, "value_mode:", value_mode, "ref level:", levelNum, "factTable:", factTable);

    // ---- STEP 1: look up t_level and t_denom (same logic as /api/map-data) ----
    const metaSql = `
      SELECT t_level, t_denom
      FROM ${factTable}
      WHERE t_code = ?
        AND time   = ?
        AND level  = ?
      LIMIT 1
    `;

    try {
      const metaRows = await duckAll(metaSql, [t_code, year, levelNum]);

      const meta = metaRows[0] || {};
      const t_level = meta.t_level ?? null;
      const denomCode = meta.t_denom ?? null;

      const wantPercent =
        value_mode === "percent" &&
        t_level === 1 &&
        denomCode != null &&
        denomCode !== "";

      log("[nc-ref-value] meta: t_level =", t_level, "t_denom =", denomCode, "will compute percent?", wantPercent);

      let sql;
      let params;

      if (wantPercent) {
        // percent = numerator / denominator * 100 for this single geosid
        sql = `
          SELECT
            num.val_t   AS raw_value,
            denom.val_t AS denom_value,
            CASE
              WHEN denom.val_t IS NULL OR denom.val_t = 0 THEN NULL
              ELSE (num.val_t * 100.0) / denom.val_t
            END AS value
          FROM ${factTable} AS num
          LEFT JOIN ${factTable} AS denom
            ON num.geosid = denom.geosid
           AND num.time   = denom.time
           AND num.level  = denom.level
           AND denom.t_code = ?
           AND denom.loc = 't'
          WHERE num.time   = ?
            AND num.level  = ?
            AND num.t_code = ?
            AND num.geosid = ?
            AND num.loc    = 't'
          LIMIT 1
        `;
        params = [denomCode, year, levelNum, t_code, geosid];
      } else {
        // raw value for this ref geosid
        sql = `
          SELECT
            val_t AS value
          FROM ${factTable}
          WHERE time   = ?
            AND level  = ?
            AND t_code = ?
            AND geosid = ?
            AND loc    = 't'
          LIMIT 1
        `;
        params = [year, levelNum, t_code, geosid];
      }

      const rows = await duckAll(sql, params);

      if (!rows || rows.length === 0) {
        console.warn("[nc-ref-value] No row in fact table for", {
          geosid,
          year,
          t_code,
          levelNum,
        });
        return res.status(404).json({ error: "No data for ref geosid" });
      }

      const row = rows[0];
      const payload = {
        value:
          (row.value != null ? row.value : null) ??
          (row.raw_value != null ? row.raw_value : null),
        raw_value: row.raw_value ?? null,
        denom_value: row.denom_value ?? null,
      };

      log("[nc-ref-value] result payload:", payload);
      res.set("Cache-Control", "no-cache");
      res.json(payload);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/series?focal_geosid=5550000.00&ref_geosid=35&year=2021&t_code=dnk2&value_mode=raw|percent
  app.get("/api/series", (req, res) => {
    const focalGeosid = req.query.focal_geosid;
    const refGeosid = req.query.ref_geosid || null;
    const year = req.query.year ? Number(req.query.year) : null; // used to anchor hlook lookup
    const t_code = req.query.t_code;
    const value_mode = req.query.value_mode || "raw";

    if (!focalGeosid) {
      return res.status(400).json({ error: "focal_geosid is required" });
    }
    if (!year || Number.isNaN(year)) {
      return res
        .status(400)
        .json({ error: "year is required and must be a number" });
    }
    if (!t_code) {
      return res.status(400).json({ error: "t_code is required" });
    }

    const normG = (g) => String(g).trim();

    function findHlookRow(geosid) {
      const gStr = normG(geosid);
      // Prefer the row for the anchor year; fall back to the nearest year this
      // geosid exists.  Both lookups are O(1) via HLOOK_MAP / HLOOK_YEARS
      // (previously two full scans of the 100k-row HLOOK array).
      let row = HLOOK_MAP.get(`${year}:${gStr}`);
      if (!row) {
        const years = HLOOK_YEARS.get(gStr) || [];
        if (years.length > 0) {
          const nearest = years.reduce((prev, cur) =>
            Math.abs(cur - year) < Math.abs(prev - year) ? cur : prev
          );
          row = HLOOK_MAP.get(`${nearest}:${gStr}`);
        }
      }
      return row || null;
    }

    function labelFromHlookRow(row) {
      return row ? labelWithContext(row) : null;
    }

    const focalH = findHlookRow(focalGeosid);
    if (!focalH) {
      console.warn("[series] no HLOOK row for focal", { focalGeosid, year });
      return res.status(404).json({ error: "No metadata for focal geosid" });
    }
    const focalLevel = Number(focalH.level);
    const focalTable = DATA_TABLE[focalLevel];
    if (!focalLevel || !focalTable) {
      return res
        .status(400)
        .json({ error: `No data table configured for focal level ${focalLevel}` });
    }
    const focalLabel = labelFromHlookRow(focalH);

    let refH = null;
    let refLevel = null;
    let refTable = null;
    let refLabel = null;

    if (refGeosid) {
      refH = findHlookRow(refGeosid);
      if (!refH) {
        console.warn("[series] no HLOOK row for ref", { refGeosid, year });
      } else {
        refLevel = Number(refH.level);
        refTable = DATA_TABLE[refLevel];
        if (!refTable) {
          console.warn("[series] no fact table for ref level", refLevel);
        } else {
          refLabel = labelFromHlookRow(refH);
        }
      }
    }

    log("[series] params:", { focalGeosid, refGeosid, year, t_code, value_mode, focalLevel, focalTable, refLevel, refTable });

    // Helper: fetch t_level + t_denom for this t_code in a given table
    function fetchMeta(table) {
      const metaSql = `
        SELECT t_level, t_denom
        FROM ${table}
        WHERE t_code = ?
        LIMIT 1
      `;
      return duckAll(metaSql, [t_code]).then((rows) => {
        const meta = rows[0] || {};
        return {
          t_level: meta.t_level ?? null,
          t_denom: meta.t_denom ?? null,
        };
      });
    }

    // Helper: fetch full time series for one (geosid, table). Through the
    // lineage concordance the series follows the PLACE: each census year is
    // read from that year's member geosid (pre-1981 codes are reused), and
    // years outside the lineage are not returned. Without a lineage row the
    // same-code series is used, trimmed to its era (see eraYears).
    async function fetchSeriesFor(geosid, levelNum, table) {
      const lin = lineageFor(geosid, year, levelNum);
      const memberOf = lin ? new Map(lin.members.map((m) => [m.time, m.geosid])) : null;
      const memberIds = lin ? [...new Set(lin.members.map((m) => m.geosid))] : [String(geosid)];
      const { t_level, t_denom } = await fetchMeta(table);
      const wantPercent =
        value_mode === "percent" &&
        t_level === 1 &&
        t_denom != null &&
        t_denom !== "";

      log("[series] meta for", geosid, { t_level, t_denom, wantPercent });

      let sql, params;

      if (wantPercent) {
        // Percent series: numerator (t_code) / denominator (t_denom) * 100,
        // for every time point, for this geosid.
        sql = `
          SELECT
            num.time,
            num.geosid,
            num.val_t   AS raw_value,
            denom.val_t AS denom_value,
            CASE
              WHEN denom.val_t IS NULL OR denom.val_t = 0 THEN NULL
              ELSE (num.val_t * 100.0) / denom.val_t
            END AS value
          FROM ${table} AS num
          LEFT JOIN ${table} AS denom
            ON num.geosid = denom.geosid
           AND num.time   = denom.time
           AND num.level  = denom.level
           AND denom.t_code = ?
           AND denom.loc = 't'
          WHERE num.geosid IN (${memberIds.map(() => "?").join(",")})
            AND num.t_code = ?
            AND num.level  = ?
            AND num.loc    = 't'
          ORDER BY num.time
        `;
        params = [t_denom, ...memberIds, t_code, levelNum];
      } else {
        // Raw series: just val_t over time for this geosid + t_code.
        sql = `
          SELECT
            time,
            geosid,
            val_t AS value
          FROM ${table}
          WHERE geosid IN (${memberIds.map(() => "?").join(",")})
            AND t_code = ?
            AND level  = ?
            AND loc    = 't'
          ORDER BY time
        `;
        params = [...memberIds, t_code, levelNum];
      }

      let rows = await duckAll(sql, params);
      if (memberOf) rows = rows.filter((r) => memberOf.get(Number(r.time)) === String(r.geosid ?? geosid));

      // Filter to finite points and dedupe by time (the source tables can carry
      // more than one row per (geosid, time, t_code); duplicates previously
      // leaked into the chart as repeated points).
      const seen = new Set();
      const series = [];
      for (const r of rows) {
        const time = Number(r.time);
        const value =
          r.value != null
            ? Number(r.value)
            : r.raw_value != null
            ? Number(r.raw_value)
            : null;
        if (!Number.isFinite(time) || value == null || !Number.isFinite(value)) continue;
        if (seen.has(time)) continue;
        seen.add(time);
        series.push({ time, value });
      }
      return series;
    }

    // Fetch focal and ref series in parallel (previously strictly sequential)
    const focalPromise = fetchSeriesFor(focalGeosid, focalLevel, focalTable);
    const refPromise =
      refGeosid && refTable
        ? fetchSeriesFor(refGeosid, refLevel, refTable).catch((err) => {
            // Return focal series with no ref rather than a hard failure
            console.error("[series] ref fetch failed:", err);
            return null;
          })
        : Promise.resolve(null);

    // A series must not cross into years where the code named another place
    // (pre-1981 code reuse): keep only the era of the anchor year.
    const inEra = (geosid, series) => {
      if (lineageFor(geosid, year)) return series;          // already lineage-resolved
      const era = new Set(eraYears(geosid, year));
      return era.size ? series.filter((p) => era.has(p.time)) : series;
    };
    Promise.all([focalPromise, refPromise])
      .then(([focalSeries, refSeries]) => {
        focalSeries = inEra(focalGeosid, focalSeries);
        if (refSeries) refSeries = inEra(refGeosid, refSeries);
        res.set("Cache-Control", "no-cache");
        res.json({
          focal: {
            geosid: focalGeosid,
            level: focalLevel,
            label: focalLabel,
            series: focalSeries,
          },
          ref:
            refSeries != null
              ? {
                  geosid: refGeosid,
                  level: refLevel,
                  label: refLabel,
                  series: refSeries,
                }
              : null,
        });
      })
      .catch((err) => handleError(res, err));
  });

  // ── Dispatch ───────────────────────────────────────────────────────────────
  // Resolves when the handler calls res.json()/res.end(); several handlers
  // (series, topology) answer from a promise chain they don't return.
  function handle(pathname, query = {}) {
    const handler = ROUTES.get(pathname);
    if (!handler) return Promise.resolve({ status: 404, body: { error: `no route ${pathname}` } });
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(n) { this.statusCode = n; return this; },
        set() { return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
        end() { resolve({ status: this.statusCode, body: null }); return this; },
      };
      Promise.resolve()
        .then(() => handler({ query }, res))
        .catch((err) => handleError(res, err));
    });
  }

  await loadLineage();
  log("startup:lineage");
  return { handle };
}
