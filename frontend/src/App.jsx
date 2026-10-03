// src/App.jsx
//
// Main application shell for the Canadian Census Observatory.
//
// Selection cascade (each step depends on the prior):
//   geo selected → level resolved → themes available → year selected
//     → codes available → map rendered + plots rendered
//
// State lives in a single useReducer (see `reducer` below).
// API calls are in individual useEffect hooks, each dependent on the
// subset of state they need.
import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as topojson from "topojson-client";
import {
  AppShell, Group, Stack, Title, Text, TextInput,
  Switch, ScrollArea, Divider, ActionIcon, Button, UnstyledButton,
  Select, SegmentedControl, Anchor,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconSun, IconMoon,
  IconFocus2,
  IconInfoCircle,
  IconLock,
} from "@tabler/icons-react";
import { APP_VERSION, APP_LAST_UPDATED, DATA_LAST_UPDATED, geoDisplayName, geoOptionLabel, seriesColors, COLOR_BRAND, COLOR_BRAND_DARK } from "./config";
import { faCircleChevronLeft, faCalendar } from "@fortawesome/free-solid-svg-icons";
import FaIcon from "./FaIcon";
import ChoroplethMap from "./ChoroplethMap";
import HelpOverlay from "./HelpOverlay";

// The static pages are just iframes — no need to ship them in the main chunk.
const Documentation = React.lazy(() => import("./pages/Documentation"));
const About = React.lazy(() => import("./pages/About"));
import CatPlot from "./CatPlot.jsx";
import OrdPlot from "./OrdPlot.jsx";
import NCPlot from "./NCPlot.jsx";
import LongitudinalPlot from "./LongitudinalPlot";
import PlotsTray, { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH } from "./PlotsTray";
import YearCoverage, { AXIS_Y as COVERAGE_AXIS_Y } from "./YearCoverage";
import { apiFetch } from "./data/apiFetch";

// The /api/* URLs are answered in the browser by data/routes.js (see
// data/apiFetch.js); the origin only has to make them absolute.
const API_BASE = window.location.origin;

// Map data arrives in two parts: geometryPayload ({ fc, level, year }, cached
// per level/year) and valuesPayload ({ rows, t_level, t_denom, ... }, small,
// refetched per variable).  displayValues joins them client-side.

const initialState = {
  geosid: "3506008",  // Ottawa (C) - CSD
  level: 2,
  year: 2021,

  theme: "dnk2",
  themeLabel: "Population Density",
  themeType: "nc",

  t_code: "dnk2",
  codeLabel: "Population Density (sq. km)",
  codeLevel: -1,

  valueMode: "percent",
  useLogScale: false,

  refGeosid: null,
  refLabel: "",
};

const LEVEL_LABEL = {
  1: "ct",
  2: "csd",
  3: "cd",
  4: "cma",
  5: "pr",
};
// Plain-English plural for the caption shown while no geography is selected.
const LEVEL_NAME = {
  1: "census tracts",
  2: "census subdivisions",
  3: "census divisions",
  4: "metropolitan areas",
  5: "provinces and territories",
};

// Census tracts are the one level whose popups name a metro area rather than a
// province: a tract's name IS its numeric id, so "5550004.01, Ontario" locates
// it only to within a thousand kilometres, while "5550004.01, London" places
// it. Every other level keeps the province.
const CT_LEVEL = 1;



function reducer(state, action) {
  switch (action.type) {
    case "setPlace":
      return { ...state, geosid: action.geosid };
    case "setYear":
      return { ...state, year: action.year };
    case "setLevel":
      return { ...state, level: action.level };
    case "setTheme":
          return {
            ...state,
            theme: action.theme,
            themeLabel: action.themeLabel ?? state.themeLabel,
            themeType: action.themeType ?? null,
            // Reset the code selection entirely — including codeLevel, which
            // otherwise leaks the previous variable's -1 into
            // isNonCountVariable and churns valueMode (and with it, fetches).
            t_code: null,
            codeLabel: "",
            codeLevel: null,
            intendedCode: null,
            intendedLabel: "",
    };
    case "setCode":
      // `intended` marks an explicit pick in the Variable list. The intent
      // outlives years/levels that lack the variable: the codes effect shows
      // a fallback there and restores the intended code when it exists again.
      return {
        ...state,
        t_code: action.t_code,
        codeLabel: action.codeLabel ?? state.codeLabel,
        codeLevel: action.codeLevel ?? null,
        ...(action.intended ? { intendedCode: action.t_code, intendedLabel: action.codeLabel ?? "" } : {}),
      };
    case "setValueMode":
      return {
        ...state,
        valueMode: action.valueMode,   // "raw" or "percent"
      };
    case "setLogScale":
      return {
        ...state,
        useLogScale: action.useLogScale,
      };
    case "setRefPlace":
      return {
        ...state,
        refGeosid: action.geosid,
        refLabel: action.label ?? "",
      };

    default:
      return state;
  }
}

// Try multiple possible key names so this works regardless of how topicOptions is shaped
function findThemeMeta(theme, topicOptions) {
  if (!theme || !Array.isArray(topicOptions)) return null;

  return (
    topicOptions.find(
      (opt) =>
        opt.t_theme === theme ||   // backend shape: { t_theme, t_themedescr, t_type }
        opt.value === theme ||     // mapped shape: { value, label, t_type }
        opt.theme === theme        // just in case we named it "theme"
    ) || null
  );
}


function ResizeHandle({ side, currentWidth, onResize, onCollapse, minWidth = 180, maxWidth = 560 }) {
  const [hovered, setHovered] = useState(false);

  function handleMouseDown(e) {
    const startX = e.clientX;
    const startW = currentWidth;
    let moved = false;

    function onMove(ev) {
      const delta = side === "right" ? ev.clientX - startX : startX - ev.clientX;
      if (Math.abs(delta) > 3) moved = true;
      onResize(Math.max(minWidth, Math.min(maxWidth, startW + delta)));
    }
    function onUp() {
      if (!moved) onCollapse();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Drag to resize · Click to collapse"
      style={{
        position: "absolute",
        [side === "right" ? "right" : "left"]: 0,
        top: 0, bottom: 0,
        width: 6,
        cursor: "col-resize",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{
        width: 3,
        height: 28,
        borderRadius: 2,
        background: hovered ? "var(--mantine-color-blue-6)" : "var(--mantine-color-gray-6)",
        opacity: hovered ? 1 : 0.75,
        transition: "background 0.15s, opacity 0.15s",
        pointerEvents: "none",
      }} />
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Live mirror of `state` for async effects: a fetch that resolves after a
  // later dispatch must decide against the CURRENT selection, not the render
  // snapshot it was started from (the codes fetch below is the case that bit:
  // it kept the variable in its stale closure and never dispatched it back).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Treat as non-count if:
  //  - the theme itself is nc, OR
  //  - the selected code has t_level == -1
  const isNonCountVariable =
    state.themeType === "nc" || state.codeLevel === -1;

  const effectiveValueMode = isNonCountVariable ? "raw" : state.valueMode;

  const logForNc = isNonCountVariable && state.useLogScale;

  // For /api/geos
  const [geoSearch, setGeoSearch] = useState("");
  const [geoOptions, setGeoOptions] = useState([]);
  const [geoStatus, setGeoStatus] = useState("No search yet.");
  
  // For reference geography — free-text search (mirrors focal geo search)
  const [refSearch, setRefSearch] = useState("");
  const [refGeoOptions, setRefGeoOptions] = useState([]);
  const [refGeoStatus, setRefGeoStatus] = useState("Type to search…");

  // Label for the currently selected ref geo (kept so the sentinel item can
  // show it while refGeoOptions is empty between searches).
  const [selectedRefLabel, setSelectedRefLabel] = useState("");

  // GeoJSON Feature for the selected reference geography, fetched individually
  // so it can be displayed at any level regardless of the current map layer.
  const [refPolygon, setRefPolygon] = useState(null);

  // For /api/ping
  const [pingResult, setPingResult] = useState(null);
  const [pingLoading, setPingLoading] = useState(false);

  // Derived label for level (once we start setting it)
  const levelStr = state.level ? LEVEL_LABEL[state.level] ?? null : null;

  // For plot_cat
  const [csPayload, setCsPayload] = useState(null);

  // For longitudinal plot
  const [seriesPayload, setSeriesPayload] = useState(null);

  // Layout state
  const [searchColOpen, setSearchColOpen] = useState(true);
  const [searchColWidth, setSearchColWidth] = useState(340);
  const [activePage, setActivePage] = useState("map");
  const [showHelpOverlay, setShowHelpOverlay] = useState(false);

  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const [showBasemap, setShowBasemap] = useState(true);

  // Each time a zoom button is clicked, its counter increments and ChoroplethMap
  // runs fitBounds for that geography.  Using a counter (not a boolean) means
  // clicking the button twice in a row while the map is unchanged still fires.
  const [focalZoomSeq, setFocalZoomSeq] = useState(0);
  const [refZoomSeq,   setRefZoomSeq]   = useState(0);

  // Tracks which theme has already had its best-code auto-selected, so we
  // only fire once per theme switch rather than on every payload refresh.
  const autoSelectThemeRef = useRef(null);

  // Ref to the plots tray DOM node — used only to anchor the help overlay.
  const plotsTrayRef = useRef(null);
  const [plotsOpen, setPlotsOpen] = useState(true);
  const [plotsWidth, setPlotsWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [yearCoverageOpen, setYearCoverageOpen] = useState(false);
  // The flyout is anchored to its own button rather than to the top of the map,
  // so it does not sit on top of the legend. Measured on open; the map wrapper
  // is the offset parent.
  const yearBtnRef = useRef(null);
  const [coverageTop, setCoverageTop] = useState(120);
  // The strip is an absolutely-positioned SVG, so it needs a pixel width.
  // Track the viewport rather than guessing; the flyout spans the map area.
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Refs to major interface elements, used only to anchor the help overlay's
  // coach marks (getBoundingClientRect() at overlay-open/step time).
  const helpGeoSearchRef     = useRef(null);
  const helpRefGeoRef        = useRef(null);
  const helpVariableRef      = useRef(null);
  const helpDisplayOptsRef   = useRef(null);
  const helpMapRef           = useRef(null);
  const helpLegendRef        = useRef(null);

  // The help overlay only makes sense on the map page — close it if the
  // user navigates away while it's open.
  useEffect(() => {
    if (activePage !== "map" && showHelpOverlay) setShowHelpOverlay(false);
  }, [activePage, showHelpOverlay]);

  // Label for the currently selected geo (kept so Select can display it when geosid
  // is set externally, e.g. by clicking a polygon, before new search results load).
  const [selectedGeoLabel, setSelectedGeoLabel] = useState("Ottawa (C) - CSD (2001-2021)");

  // Index of the option that represents `geosid` in a search-result list.
  // Several options can share a geosid (one per name era, pre-1981 codes are
  // reused), so prefer the one whose year span holds the current year; fall
  // back to the first with that geosid. -1 when none.
  const optionIndexFor = (opts, geosid, year) => {
    if (!geosid) return -1;
    const same = opts.map((g, i) => ({ g, i })).filter(({ g }) => String(g.geosid) === String(geosid));
    if (!same.length) return -1;
    const y = Number(year);
    const hit = same.find(({ g }) => g.year_min == null || (y >= Number(g.year_min) && y <= Number(g.year_max)));
    if (hit) return hit.i;
    // The same code in another era is a different place: never show that
    // entry as the selection (the sentinel item shows the real label instead).
    return same.some(({ g }) => g.year_min != null) ? -1 : same[0].i;
  };

  // Effective reference geography — purely the user's explicit choice.
  const effectiveRefGeosid = state.refGeosid || null;
  const effectiveRefLabel  = state.refLabel  || "";
  // The focal label the plots may show: gated on the geosid so a cleared
  // geography never survives as a name (selectedGeoLabel is kept for the
  // Select's own sentinel item and is not reliable on its own).
  const effectiveFocalLabel = state.geosid ? selectedGeoLabel : "";

  // Clearing a geography has to clear everything that names it: the reducer
  // field, the label the Select and plots display, and the search text.
  // Both Selects' clear buttons and the map's shift+click toggle use these.
  const clearPlace = () => {
    dispatch({ type: "setPlace", geosid: null });
    setSelectedGeoLabel("");
    setGeoSearch("");
  };
  const clearRef = () => {
    dispatch({ type: "setRefPlace", geosid: null, label: "" });
    setSelectedRefLabel("");
    setRefSearch("");
  };

  // Apply a search-list entry as the focal or comparison geography.
  // Entries come in two kinds: a lineage entry (csd/cd, carries `geouid`,
  // spans every census the place exists in, geosid = its last-year member)
  // and an era entry (one code, the years in which it named this place).
  // For a lineage entry in a year inside its span the current year's member
  // is looked up; otherwise, for the focal geography, the year moves to the
  // entry's last year so the map shows the place that was picked.
  const selectSearchEntry = (found, which) => {
    const label = geoOptionLabel(found.label, found.geosid);
    const y = Number(stateRef.current.year);
    const inSpan = found.year_max == null || (y >= Number(found.year_min) && y <= Number(found.year_max));
    const apply = (geosid) => {
      if (which === "focal") {
        dispatch({ type: "setPlace", geosid });
        setSelectedGeoLabel(label);
        setGeoSearch(label);
      } else {
        dispatch({ type: "setRefPlace", geosid, label });
        setSelectedRefLabel(label);
        setRefSearch(label);
      }
    };
    if (found.geouid && inSpan && y !== Number(found.year_max)) {
      fetchLineage(found.geosid, found.year_max, null).then((l) => {   // entry may be at another level
        const m = l?.members?.find((x) => Number(x.time) === y);
        apply(m ? m.geosid : found.geosid);
      });
      return;
    }
    if (which === "focal" && found.year_max != null && !inSpan) {
      // Prefer the latest year in the span that carries the current variable,
      // so the variable survives the jump (New Toronto 1931-1961: density has
      // no 1961 CSD polygons, so land on 1951, not 1961 and a reset variable).
      const lo = Number(found.year_min), hi = Number(found.year_max);
      const withVar = codeYears.available.map(Number).filter((t) => t >= lo && t <= hi);
      const target = withVar.length ? Math.max(...withVar) : hi;
      dispatch({ type: "setYear", year: target });
      if (found.geouid && target !== hi) {
        fetchLineage(found.geosid, hi, null).then((l) => {
          const m = l?.members?.find((x) => Number(x.time) === target);
          apply(m ? m.geosid : found.geosid);
        });
        return;
      }
    }
    apply(found.geosid);
  };



  // Debounced geography search — fires 300 ms after the user stops typing
useEffect(() => {
  let cancelled = false;

  // If the user hasn't typed anything yet, clear list + show hint
  if (geoSearch.trim() === "") {
    setGeoOptions([]);
    setGeoStatus("Type at least 1 character to search.");
    return () => {
      cancelled = true;
    };
  }

  const timeoutId = setTimeout(async () => {
    setGeoStatus("Loading...");
    try {
      const url = new URL(`${API_BASE}/api/geos`);
      url.searchParams.set("q", geoSearch.trim());

      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geos = await res.json();
      if (cancelled) return;

      setGeoOptions(geos);
      setGeoStatus(
        geos.length === 0
          ? "No matches."
          : `Showing ${geos.length} matches.`
      );
    } catch (err) {
      console.error(err);
      if (!cancelled) {
        setGeoStatus(`Error loading geos: ${err.message}`);
      }
    }
  }, 300); // 300ms debounce

  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
  };
}, [geoSearch]);

// Debounced reference geography search — identical pattern to focal geo search
useEffect(() => {
  let cancelled = false;

  if (refSearch.trim() === "") {
    setRefGeoOptions([]);
    setRefGeoStatus("Type to search…");
    return () => { cancelled = true; };
  }

  const timeoutId = setTimeout(async () => {
    setRefGeoStatus("Loading...");
    try {
      const url = new URL(`${API_BASE}/api/geos`);
      url.searchParams.set("q", refSearch.trim());
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geos = await res.json();
      if (cancelled) return;
      setRefGeoOptions(geos);
      setRefGeoStatus(geos.length === 0 ? "No matches." : `Showing ${geos.length} matches.`);
    } catch (err) {
      console.error(err);
      if (!cancelled) setRefGeoStatus(`Error loading geos: ${err.message}`);
    }
  }, 300);

  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
  };
}, [refSearch]);

// --- Fetch the reference geography polygon whenever the selection or year changes ---
useEffect(() => {
  const geosid = effectiveRefGeosid;
  if (!geosid || !state.year) {
    setRefPolygon(null);
    return;
  }
  let cancelled = false;
  apiFetch(`${API_BASE}/api/geo-polygon?geosid=${encodeURIComponent(geosid)}&year=${state.year}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (!cancelled) setRefPolygon(data ?? null); })
    .catch(() => { if (!cancelled) setRefPolygon(null); });
  return () => { cancelled = true; };
}, [effectiveRefGeosid, state.year]);

// --- Fetch level metadata when place or year changes ---
// levelFor records which geosid state.level was resolved for, so downstream
// fetch effects can skip the window where a new geography is selected but the
// level in state still belongs to the previous one (previously this fired
// wrong-level plot/map requests that were immediately superseded).
const [levelFor, setLevelFor] = useState(initialState.geosid);

useEffect(() => {
  if (!state.geosid || !state.year) return;
  const controller = new AbortController();

  async function fetchLevel() {
    try {
      const url = new URL(`${API_BASE}/api/level`);
      url.searchParams.set("geosid", state.geosid);
      url.searchParams.set("year", String(state.year));

      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error("Level fetch failed:", res.status);
        return;
      }

      const meta = await res.json();
      // meta.level should be 1–5 from hlook
      dispatch({ type: "setLevel", level: meta.level });
      setLevelFor(state.geosid);
      if (import.meta.env.DEV) console.log("Level meta:", meta);
    } catch (err) {
      if (err.name !== "AbortError") console.error("Error fetching level:", err);
    }
  }

  fetchLevel();
  return () => controller.abort();
}, [state.geosid, state.year]);


// --- Fetch topics for this place+level, keep theme if still valid ---
const [topicOptions, setTopicOptions] = useState([]);

// Fetch themes when level or year changes
useEffect(() => {
  async function fetchThemes() {
    if (!state.level || !state.year) {
      setTopicOptions([]);
      return;
    }

    try {
      const url = new URL(`${API_BASE}/api/themes`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year || 2021));

      if (import.meta.env.DEV) console.log("Fetching themes with", { level: state.level, year: state.year || 2021 });

      const res = await apiFetch(url);
      if (!res.ok) {
        console.error("Theme fetch failed:", res.status);
        setTopicOptions([]);
        return;
      }

      // ✅ EXPECT: [{ t_theme, t_themedescr, t_type }, ...]
      const themes = await res.json();

      // ✅ Normalize once for consistent frontend shape.
      // Dedupe by t_theme defensively: a duplicate option value makes
      // Mantine's Select throw and white-screens the whole app (seen with
      // "lnof" in 2016 from an upstream all_descr data issue).
      const seenThemes = new Set();
      const opts = [];
      for (const t of themes) {
        if (seenThemes.has(t.t_theme)) continue;
        seenThemes.add(t.t_theme);
        opts.push({
          value: t.t_theme,
          label: t.t_themedescr,
          t_type: t.t_type ?? null,
        });
      }

      setTopicOptions(opts);

      const availableThemes = opts.map((t) => t.value);

      // ✅ Pick theme to use (keep current if still valid)
      const newTheme =
        state.theme && availableThemes.includes(state.theme)
          ? state.theme
          : availableThemes.length > 0
          ? availableThemes[0]
          : null;

      if (newTheme !== state.theme && newTheme != null) {
        const selected = opts.find((t) => t.value === newTheme);
        const themeLabel = selected?.label ?? newTheme;
        const themeType  = selected?.t_type ?? null;

        // ✅ IMPORTANT: now setting themeType in reducer
        dispatch({
          type: "setTheme",
          theme: newTheme,
          themeLabel,
          themeType,
        });
      }
    } catch (err) {
      console.error("Error fetching themes:", err);
      setTopicOptions([]);
    }
  }

  fetchThemes();
}, [state.level, state.year]);

// Available years for the selected geography (from hlook, independent of theme)
// Lineage (geouid) of the selected primary and comparison units, from the
// concordance (CSD and CD, 1851-2021). A lineage lists the member geosid in
// every census the place exists in, so a year change can follow the PLACE
// instead of keeping the code, which before 1981 belongs to a different unit
// each census. Refs, not state: nothing renders from them directly.
const focalLineageRef = useRef(null);
const refLineageRef = useRef(null);
const fetchLineage = (geosid, year, level = stateRef.current.level) =>
  apiFetch(`${API_BASE}/api/lineage?geosid=${encodeURIComponent(geosid)}&year=${year}${level ? `&level=${level}` : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
useEffect(() => {
  if (!state.geosid) { focalLineageRef.current = null; return; }
  const geosid = state.geosid;
  fetchLineage(geosid, stateRef.current.year).then((l) => {
    if (stateRef.current.geosid === geosid) focalLineageRef.current = l;
  });
}, [state.geosid, state.year]);
useEffect(() => {
  if (!effectiveRefGeosid) { refLineageRef.current = null; return; }
  const geosid = effectiveRefGeosid;
  fetchLineage(geosid, stateRef.current.year).then((l) => {
    if (stateRef.current.refGeosid === geosid) refLineageRef.current = l;
  });
}, [effectiveRefGeosid, state.year]);

// Follow the lineage across a year change: swap each selection to its member
// in the new year. The Year pulldown only offers the lineage's years for the
// primary, so a member is normally found; when it is not (comparison whose
// lineage lacks the year) the selection is left alone and simply has no data.
const lineageLabel = (lin, m) =>
  `${m.geoname ?? m.geosid} - ${(LEVEL_LABEL[lin.level] ?? "").toUpperCase()} (${lin.first_year === lin.last_year ? lin.first_year : `${lin.first_year}-${lin.last_year}`})`;
// changeYear: every user-driven year change goes through here so the lineage
// swaps land in the same render batch as the new year — otherwise the level
// and values effects fire once for the OLD code at the new year (a 404 and a
// wasted fetch) before the swap catches up.
const changeYear = (year) => {
  const y = Number(year);
  if (!Number.isFinite(y)) return;
  const cur = stateRef.current;
  const fl = focalLineageRef.current;
  if (cur.geosid && fl) {
    const m = fl.members.find((x) => Number(x.time) === y);
    if (m && String(m.geosid) !== String(cur.geosid)) {
      const label = lineageLabel(fl, m);
      dispatch({ type: "setPlace", geosid: m.geosid });
      setSelectedGeoLabel(label);
      // Mantine only re-syncs a searchable Select's text when its value
      // string changes; across lineage swaps the value is often the same
      // sentinel, so the text must be set here or the box goes blank.
      setGeoSearch(label);
    }
  }
  const rl = refLineageRef.current;
  if (cur.refGeosid && rl) {
    const m = rl.members.find((x) => Number(x.time) === y);
    if (m && String(m.geosid) !== String(cur.refGeosid)) {
      const label = lineageLabel(rl, m);
      dispatch({ type: "setRefPlace", geosid: m.geosid, label });
      setSelectedRefLabel(label);
      setRefSearch(label);
    }
  }
  dispatch({ type: "setYear", year: y });
};

const [geoYears, setGeoYears] = useState([]);
useEffect(() => {
  if (!state.geosid) { setGeoYears([]); return; }
  // Anchor on the year in force when the geography was chosen: the server
  // returns only the years in which this code names the same place (pre-1981
  // codes are reused), so the Year pulldown cannot wander into another unit.
  const anchorYear = stateRef.current.year ?? state.year;
  // The level is sent too: a unit-year with data but no polygon (csd 1961)
  // has no hlook row for the server to read the level from.
  apiFetch(`${API_BASE}/api/geoyears?geosid=${encodeURIComponent(state.geosid)}${anchorYear ? `&year=${anchorYear}` : ""}${state.level ? `&level=${state.level}` : ""}`)
    .then(r => r.ok ? r.json() : [])
    .then(years => {
      setGeoYears(years);
      if (years.length > 0 && !years.includes(state.year)) {
        dispatch({ type: "setYear", year: Math.max(...years) });
      }
    })
    .catch(() => setGeoYears([]));
  // state.year is a dependency on purpose: picking an entry that reuses the
  // current code in another era (Barton 1861 -> Beckwith 1891, both 3540002)
  // changes the year but not the geosid, and the years must follow the era.
}, [state.geosid, state.year]);


// Per-variable year coverage: which census years carry THIS t_code, and which
// census years exist at all for the level. /api/years is theme-level and so
// overstates coverage for any variable narrower than its theme.
const [codeYears, setCodeYears] = useState({ census: [], available: [] });
useEffect(() => {
  // Deliberately sticky. Changing the year clears codeOptions, which nulls
  // t_code for a beat before the new codes land (see the default-code effect);
  // wiping coverage on that transient would unmount the flyout and disable its
  // button mid-interaction. Keeping the last-known values costs one fetch of
  // staleness and keeps the panel steady while the user works in it.
  if (!state.level || !state.t_code) return;
  const controller = new AbortController();
  const url = new URL(`${API_BASE}/api/code-years`);
  url.searchParams.set("level", String(state.level));
  url.searchParams.set("t_code", state.t_code);
  apiFetch(url, { signal: controller.signal })
    .then(r => r.ok ? r.json() : { census: [], available: [] })
    .then(d => setCodeYears({ census: d.census ?? [], available: d.available ?? [] }))
    .catch(err => { if (err.name !== "AbortError") console.error("[code-years]", err); });
  return () => controller.abort();
}, [state.level, state.t_code]);

// Which levels carry the current variable in the current year: the Level
// control enables exactly these. Sticky on the transient null t_code for the
// same reason as codeYears above.
const [codeLevels, setCodeLevels] = useState([]);
useEffect(() => {
  if (!state.t_code || !state.year) return;
  const controller = new AbortController();
  const url = new URL(`${API_BASE}/api/code-levels`);
  url.searchParams.set("t_code", state.t_code);
  url.searchParams.set("year", String(state.year));
  apiFetch(url, { signal: controller.signal })
    .then(r => r.ok ? r.json() : { levels: [] })
    .then(d => setCodeLevels((d.levels ?? []).map(Number)))
    .catch(err => { if (err.name !== "AbortError") console.error("[code-levels]", err); });
  return () => controller.abort();
}, [state.t_code, state.year]);

const [yearOptions, setYearOptions] = useState([]);
useEffect(() => {
  async function fetchYears() {
    if (!state.level || !state.theme) {
      setYearOptions([]);
      return;
    }

    try {
      const url = new URL(`${API_BASE}/api/years`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("t_theme", state.theme);

      if (import.meta.env.DEV) console.log("Fetching years with", { level: state.level, t_theme: state.theme });

      const res = await apiFetch(url);
      if (!res.ok) {
        console.error("Year fetch failed:", res.status);
        setYearOptions([]);
        return;
      }

      const years = (await res.json()).map(Number); // normalize to numbers
      setYearOptions(years);

      // Keep current year if still available, otherwise choose a sensible default
      if (years.length > 0 && !years.includes(Number(state.year))) {
        const newYear = Math.max(...years);
        if (newYear !== state.year) {
          dispatch({ type: "setYear", year: newYear });
        }
      }
    } catch (err) {
      console.error("Error fetching years:", err);
      setYearOptions([]);
    }
  }

  fetchYears();
}, [state.level, state.theme]);

// The single definition of "which years can I pick" — the Year pulldown and the
// coverage strip both read this, so they can never disagree.
//
// Narrowest-wins, but never to nothing: each filter is only applied when it
// leaves something behind, which preserves the old pulldown's behaviour of
// falling back rather than presenting an empty list.
// themeYears: the years the THEME (and the selected geography) exist in.
// This is what the Year list offers, so a year is never unreachable just
// because the current variable is missing there (project-lead decision,
// 2026-09-09: such years are dimmed, and picking one shows a fallback).
const themeYears = useMemo(() => {
  let years = (state.theme && yearOptions.length > 0) ? yearOptions : geoYears;
  years = years.map(Number);
  if (geoYears.length > 0) {
    const geoSet = new Set(geoYears.map(Number));
    const narrowed = years.filter(y => geoSet.has(y));
    if (narrowed.length > 0) years = narrowed;
  }
  return [...new Set(years)].sort((a, b) => a - b);
}, [state.theme, yearOptions, geoYears]);
// availableYears: themeYears that also carry the current variable (coverage
// summary, coverage strip, search-entry year jumps).
const availableYears = useMemo(() => {
  let years = themeYears;
  if (codeYears.available.length > 0) {
    const codeSet = new Set(codeYears.available.map(Number));
    const narrowed = years.filter(y => codeSet.has(y));
    if (narrowed.length > 0) years = narrowed;
  }
  return years;
}, [themeYears, codeYears]);
const availableYearSet = useMemo(() => new Set(availableYears), [availableYears]);

// One line of plain text under the closed Year field, so the coverage fact is
// legible without opening anything.
// Map area minus the flyout's own inset and padding.
// Map area, less the flyout inset (12 + 20), the pointer (8), and the
// panel's own horizontal padding (28).
// The rail keeps at least 320px of map beside it. Clamped here rather than
// written back into plotsWidth, so widening the window restores the width the
// user actually chose.
const effectivePlotsWidth = Math.min(
  plotsWidth,
  RAIL_MAX_WIDTH,
  Math.max(RAIL_MIN_WIDTH, viewportWidth - (searchColOpen ? searchColWidth : 0) - 320),
);

const coverageWidth = Math.max(320, viewportWidth - (searchColOpen ? searchColWidth : 0) - (plotsOpen ? effectivePlotsWidth : 0) - 12 - 20 - 8 - 28);

const coverageSummary = useMemo(() => {
  const census = codeYears.census;
  // Counts availableYears, not codeYears.available: the strip and the pulldown
  // both offer the narrowed set (variable AND geography AND theme), so the
  // sentence has to describe that same set or it contradicts what is on screen.
  if (census.length === 0 || availableYears.length === 0) return null;
  const span = availableYears.length === 1
    ? `${availableYears[0]}`
    : `${availableYears[0]}\u2013${availableYears[availableYears.length - 1]}`;
  return `${availableYears.length} of ${census.length} census years carry this variable (${span}).`;
}, [codeYears, availableYears]);

const [codeOptions, setCodeOptions] = useState([]);
// True from the moment a codes fetch starts until it settles. While it is
// set, the default-code effect below must not touch the selection: the
// options list is empty only because it is being refetched, not because the
// variable has ceased to exist (a year change with a variable that exists in
// both years used to lose it exactly this way).
const [codesLoading, setCodesLoading] = useState(false);

useEffect(() => {
  // Need level, theme, and year before we can load codes
  if (!state.level || !state.theme || !state.year) {
    setCodeOptions([]);
    setCodesLoading(false);
    return;
  }

  // Clear immediately: leaving the previous theme's options in place lets the
  // default-code effect below resurrect the OLD theme's t_code mid-cascade,
  // firing a values/series fetch that is instantly superseded. The loading
  // flag keeps that effect from reading the empty list as "no variable".
  setCodeOptions([]);
  setCodesLoading(true);

  let cancelled = false;

  async function fetchCodes() {
    try {
      const url = new URL(`${API_BASE}/api/codes`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year));
      url.searchParams.set("t_theme", state.theme);

      const res = await apiFetch(url.toString());
      if (!res.ok) {
        console.error("Failed to fetch codes", res.status, res.statusText);
        if (!cancelled) setCodeOptions([]);
        return;
      }

      // expect [{ t_code, t_name, t_level }, ...]
      const data = await res.json();
      if (cancelled) return;

      // Decide against the selection as it is NOW, not as it was when this
      // effect started (dispatches may have landed during the await).
      const cur = stateRef.current;

      if (!data || data.length === 0) {
        // clear code if nothing is available
        if (cur.t_code !== null || cur.codeLabel !== "" || cur.codeLevel !== null) {
          dispatch({
            type: "setCode",
            t_code: null,
            codeLabel: "",
            codeLevel: null,
          });
        }
        setCodeOptions(data || []);
        return;
      }

      const availableCodes = data.map((d) => d.t_code);

      // Restore the user's intended variable when this level/year carries it
      // again; else keep the current code if still valid; else fall back to
      // the theme's first variable (the caption under Variable says so).
      const newCode =
        cur.intendedCode && availableCodes.includes(cur.intendedCode)
          ? cur.intendedCode
          : cur.t_code && availableCodes.includes(cur.t_code)
            ? cur.t_code
            : data[0].t_code;

      // only dispatch if something actually changed or label/level is missing
      if (newCode !== cur.t_code || !cur.codeLabel || cur.codeLevel == null) {
        const selected = data.find((d) => d.t_code === newCode);
        dispatch({
          type: "setCode",
          t_code: newCode,
          codeLabel: selected?.t_name ?? newCode,
          codeLevel: selected?.t_level ?? null,
        });
      }
      // Options land after the selection is settled, so the default-code
      // effect sees a list that already contains the current t_code.
      setCodeOptions(data);
    } catch (err) {
      console.error("Error fetching codes:", err);
      if (!cancelled) {
        setCodeOptions([]);
      }
    } finally {
      if (!cancelled) setCodesLoading(false);
    }
  }

  fetchCodes();

  return () => {
    cancelled = true;
  };
}, [state.level, state.theme, state.year]);



useEffect(() => {
  // A refetch is in flight: the empty/old list says nothing about whether the
  // current variable exists in the new level/theme/year. Wait for it.
  if (codesLoading) return;

  if (!codeOptions || codeOptions.length === 0) {
    // no codes for this theme/year/level → clear t_code
    if (state.t_code !== null) {
      dispatch({ type: "setCode", t_code: null, codeLabel: "", codeLevel: null });
    }
    return;
  }

  // The intended variable wins whenever the list carries it (same order as
  // the codes effect); then the current code if still valid.
  const intended = state.intendedCode && codeOptions.find((c) => c.t_code === state.intendedCode);
  if (intended && intended.t_code !== state.t_code) {
    dispatch({ type: "setCode", t_code: intended.t_code, codeLabel: intended.t_name ?? intended.t_code, codeLevel: intended.t_level ?? null });
    return;
  }
  const hasCurrent = codeOptions.some(
    (c) => c.t_code === state.t_code
  );
  if (hasCurrent) return;

  // Otherwise, default to the first code in the list — with its label and
  // level, so the reducer does not null codeLevel behind the selection.
  const first = codeOptions[0];
  dispatch({
    type: "setCode",
    t_code: first.t_code,
    codeLabel: first.t_name ?? first.t_code,
    codeLevel: first.t_level ?? null,
  });
}, [codeOptions, codesLoading, state.t_code, state.intendedCode, dispatch]);

// The variable on screen is a stand-in for the one the user picked.
const codeFallback = Boolean(state.intendedCode && state.t_code && state.t_code !== state.intendedCode);

// ── Map data: geometry + values fetched separately ───────────────────────────
// Geometry for a (level, year) is static and multi-MB; values for a
// (level, year, t_code) are a few hundred KB.  Fetching them separately means
// changing the variable, year-within-level, or percent/absolute mode never
// re-downloads geometry, and the browser's HTTP cache (plus this in-memory
// cache) makes revisiting a level instant.
const [geometryPayload, setGeometryPayload] = useState(null); // { fc, level, year }
const [valuesPayload, setValuesPayload] = useState(null);     // { rows, t_level, t_denom, level, year, code }
const geometryCacheRef = useRef(new Map());                   // "level|year" → FeatureCollection
const GEOMETRY_CLIENT_CACHE_MAX = 6;

// Per-year TopoJSON bundle cache: one topology holds every level of a census
// year with shared arcs, so switching levels within a year expands locally
// (~10 ms) instead of fetching multi-MB GeoJSON.  `null` marks a year whose
// bundle 404'd — those years fall back to /api/geometry permanently.
const topologyCacheRef = useRef(new Map());                   // year → Topology | null
const TOPOLOGY_CLIENT_CACHE_MAX = 4;
const TOPO_OBJECT_BY_LEVEL = { 1: "ct", 2: "csd", 3: "cd", 4: "cma", 5: "pr" };

function expandTopologyLevel(topo, level) {
  const objName = TOPO_OBJECT_BY_LEVEL[level];
  if (!topo || !objName || !topo.objects || !topo.objects[objName]) return null;
  return topojson.feature(topo, topo.objects[objName]);
}

// CT → CMA name for the whole level, fetched once per year while tracts are
// showing. The map's polygons come from the static per-year TopoJSON bundles,
// whose feature properties carry prname only, so the metro names cannot ride
// along with the geometry and are fetched beside it instead. Nothing is
// requested at any other level.
const [ctCmaNames, setCtCmaNames] = useState(null);
const ctCmaCacheRef = useRef(new Map());                      // year → names

useEffect(() => {
  if (state.level !== CT_LEVEL || !state.year) {
    setCtCmaNames(null);
    return;
  }
  const cached = ctCmaCacheRef.current.get(state.year);
  if (cached) {
    setCtCmaNames(cached);
    return;
  }
  const ac = new AbortController();
  apiFetch(`${API_BASE}/api/ct-cma?year=${state.year}`, { signal: ac.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data?.names) return;
      ctCmaCacheRef.current.set(state.year, data.names);
      setCtCmaNames(data.names);
    })
    .catch((err) => {
      // Losing this only costs the tract popups their metro name; they fall
      // back to the province, so it is never worth surfacing as an error.
      if (err.name !== "AbortError") console.warn("[ct-cma] fetch failed", err);
    });
  return () => ac.abort();
}, [state.level, state.year]);

useEffect(() => {
  // The levelFor guard only matters while a selected geography's level is
  // still resolving; with no geography selected (geosid null) the map should
  // keep displaying the current level.
  if (!state.level || !state.year) return;
  if (state.geosid && levelFor !== state.geosid) return;

  const key = `${state.level}|${state.year}`;
  // Already showing this level/year — nothing to do.
  if (geometryPayload && geometryPayload.level === state.level && geometryPayload.year === state.year) {
    return;
  }
  const cached = geometryCacheRef.current.get(key);
  if (cached) {
    setGeometryPayload({ fc: cached, level: state.level, year: state.year });
    return;
  }

  const controller = new AbortController();
  (async () => {
    try {
      const finish = (fc) => {
        const cache = geometryCacheRef.current;
        cache.set(key, fc);
        while (cache.size > GEOMETRY_CLIENT_CACHE_MAX) {
          cache.delete(cache.keys().next().value);
        }
        setGeometryPayload({ fc, level: state.level, year: state.year });
      };

      // 1) Preferred path: the year's TopoJSON bundle (all levels, shared arcs).
      const topoCache = topologyCacheRef.current;
      let topo = topoCache.get(state.year);
      if (topo === undefined) {
        const topoRes = await apiFetch(
          // DATA_LAST_UPDATED in the URL: a data rebuild changes the bundles
          // but not their address, and browsers held the old ones for a day
          // (seen 2026-09-12: pre-1912 provinces cached over the rebuilt 1911).
          `${API_BASE}/api/topology?year=${state.year}&v=${DATA_LAST_UPDATED}`,
          { signal: controller.signal }
        );
        if (topoRes.ok) {
          topo = await topoRes.json();
        } else {
          topo = null; // 404 → no bundle for this year; remember and fall back
          if (topoRes.status !== 404) {
            console.warn("Topology fetch failed:", topoRes.status);
          }
        }
        topoCache.set(state.year, topo);
        while (topoCache.size > TOPOLOGY_CLIENT_CACHE_MAX) {
          topoCache.delete(topoCache.keys().next().value);
        }
      }
      if (topo) {
        const fc = expandTopologyLevel(topo, state.level);
        if (fc) {
          finish(fc);
          return;
        }
        console.warn("Topology bundle lacks level", state.level, "— falling back");
      }

      // 2) Fallback: per-(level, year) GeoJSON — unchanged legacy path.
      const url = new URL(`${API_BASE}/api/geometry`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year));
      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error("Geometry fetch failed:", res.status);
        setGeometryPayload(null);
        return;
      }
      finish(await res.json());
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Error fetching geometry:", err);
        setGeometryPayload(null);
      }
    }
  })();
  return () => controller.abort();
}, [state.level, state.year, state.geosid, levelFor]);

// Province overlay from the same bundle (avoids the separate /api/boundaries
// download).  Derived after geometryPayload so it tracks the resolved year.
const provincesFC = useMemo(() => {
  if (!state.year) return null;
  const topo = topologyCacheRef.current.get(state.year);
  return topo ? expandTopologyLevel(topo, 5) : null;
  // geometryPayload dependency: the cache ref isn't reactive; geometry
  // resolution is the signal that the year's bundle (or its absence) is known.
}, [state.year, geometryPayload]);

useEffect(() => {
  if (!state.level || !state.year || !state.t_code) {
    setValuesPayload(null);
    return;
  }
  // Mid-transition (a newly selected geography whose level hasn't resolved
  // yet): keep the previous values on screen rather than clearing — clearing
  // here flashed every polygon to "no data" on each polygon click.
  if (state.geosid && levelFor !== state.geosid) return;
  // Values depend only on (level, year, t_code) — a same-level geography
  // change needs no refetch at all.
  if (
    valuesPayload &&
    valuesPayload.level === state.level &&
    valuesPayload.year === state.year &&
    valuesPayload.code === state.t_code
  ) {
    return;
  }

  const controller = new AbortController();
  (async () => {
    try {
      const url = new URL(`${API_BASE}/api/values`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year));
      url.searchParams.set("t_code", state.t_code);
      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error("Values fetch failed:", res.status);
        setValuesPayload(null);
        return;
      }
      const data = await res.json();
      setValuesPayload({
        rows: data.rows ?? [],
        t_level: data.t_level ?? null,
        t_denom: data.t_denom ?? null,
        level: state.level,
        year: state.year,
        code: state.t_code,
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Error fetching values:", err);
        setValuesPayload(null);
      }
    }
  })();
  return () => controller.abort();
}, [state.level, state.year, state.t_code, state.geosid, levelFor]);

// Displayed value per geosid, derived locally.  The percent/absolute toggle
// (and any future transform) is pure client-side math over raw + denominator —
// no network round trip, no layer rebuild.
const displayValues = useMemo(() => {
  if (!valuesPayload) return null;
  const canPercent = valuesPayload.t_level === 1 && !!valuesPayload.t_denom;
  const usePercent = effectiveValueMode === "percent" && canPercent;
  const m = new Map();
  for (const r of valuesPayload.rows) {
    const raw = r.raw_value != null ? Number(r.raw_value) : null;
    const denom = r.denom_value != null ? Number(r.denom_value) : null;
    let value = raw;
    if (usePercent) {
      value = raw != null && denom ? (raw * 100) / denom : null;
    }
    m.set(String(r.geosid), value);
  }
  return m;
}, [valuesPayload, effectiveValueMode]);

// Atomic map view: geometry and values are committed to the map TOGETHER,
// and only when they describe the same (level, year).  While a level or year
// change is in flight the previous consistent pair stays on screen, so the
// map never paints a freshly mounted layer with no values (the "no data"
// flash) — it swaps once, fully colored, when both pieces are ready.
const mapViewRef = useRef(null);
const mapView = useMemo(() => {
  if (
    geometryPayload &&
    valuesPayload &&
    displayValues &&
    geometryPayload.level === valuesPayload.level &&
    geometryPayload.year === valuesPayload.year
  ) {
    mapViewRef.current = {
      geometry: geometryPayload.fc,
      values: displayValues,
      level: geometryPayload.level,
      year: geometryPayload.year,
    };
  }
  return mapViewRef.current;
}, [geometryPayload, valuesPayload, displayValues]);

// Rows for the non-count histogram (NCPlot): geoname from geometry properties,
// value from the local join.  Derived from the committed map view so the
// histogram stays consistent with what the map shows during transitions.
const ncRows = useMemo(() => {
  if (!mapView) return null;
  return mapView.geometry.features.map((f) => {
    const p = f.properties || {};
    return {
      geosid: p.geosid,
      geoname: p.geoname,
      prname: ctCmaNames?.[String(p.geosid)] ?? p.prname,
      value: mapView.values.get(String(p.geosid)) ?? null,
    };
  });
}, [mapView, ctCmaNames]);

useEffect(() => {
  // Only run this for categorical variables
  if (state.themeType !== "cat" && state.themeType !== "catm") {
    setCsPayload(null);
    return;
  }

  // Need these to be defined — and state.level must belong to the current
  // geosid (levelFor) so we never fire a wrong-level request mid-cascade.
  if (!state.level || !state.year || !state.theme || !state.geosid || levelFor !== state.geosid) {
    setCsPayload(null);
    return;
  }
  // A cleared comparison must vanish now, not when the refetch lands (or
  // never, if it fails): strip the old ref series from the payload in place.
  if (!effectiveRefGeosid) setCsPayload((p) => (p && p.ref ? { ...p, ref: null } : p));

  const controller = new AbortController();

  async function fetchCatPlot() {
    try {
      const url = new URL(`${API_BASE}/api/cs-plot`); // <-- change path if needed
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year));
      url.searchParams.set("t_theme", state.theme);
      url.searchParams.set("geosid", state.geosid);
      if (effectiveRefGeosid) {
        url.searchParams.set("ref_geosid", effectiveRefGeosid);
      }

      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error("cs-plot fetch failed, status:", res.status);
        setCsPayload(null);
        return;
      }

      const data = await res.json();
      if (import.meta.env.DEV) console.log("[cs-plot] frontend data:", data);

      // Very light sanity check: must have categories
      if (data && Array.isArray(data.categories) && data.categories.length > 0) {
        setCsPayload(data);
      } else {
        setCsPayload(null);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("cs-plot fetch error:", err);
        setCsPayload(null);
      }
    }
  }

  fetchCatPlot();
  return () => controller.abort();
}, [
  state.themeType,
  state.level,
  state.year,
  state.theme,
  state.geosid,
  levelFor,
  effectiveRefGeosid,
]);


const [osPayload, setOsPayload] = useState(null);

useEffect(() => {
  // Only relevant for ordinal / ordered categorical themes
  if (state.themeType !== "ord" && state.themeType !== "ordc") {
    setOsPayload(null);
    return;
  }

  // Need these to be defined — and state.level must belong to the current
  // geosid (levelFor) so we never fire a wrong-level request mid-cascade.
  if (!state.level || !state.year || !state.theme || !state.geosid || levelFor !== state.geosid) {
    setOsPayload(null);
    return;
  }
  if (!effectiveRefGeosid) setOsPayload((p) => (p && p.ref ? { ...p, ref: null } : p));

  const controller = new AbortController();

  async function fetchOrdPlot() {
    try {
      const url = new URL(`${API_BASE}/api/os-plot`);
      url.searchParams.set("level", String(state.level));
      url.searchParams.set("year", String(state.year));
      url.searchParams.set("t_theme", state.theme);
      url.searchParams.set("geosid", state.geosid);
      if (effectiveRefGeosid) {
        url.searchParams.set("ref_geosid", effectiveRefGeosid);
      }

      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error("os-plot fetch failed, status:", res.status);
        setOsPayload(null);
        return;
      }

      const data = await res.json();
      if (import.meta.env.DEV) console.log("[os-plot] frontend data:", data);

      if (
        data &&
        Array.isArray(data.categories) &&
        data.categories.length > 0
      ) {
        // Store raw backend shape; we'll wrap labels when we render
        setOsPayload(data);
      } else {
        setOsPayload(null);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("os-plot fetch error:", err);
        setOsPayload(null);
      }
    }
  }

  fetchOrdPlot();
  return () => controller.abort();
}, [
  state.themeType,
  state.level,
  state.year,
  state.theme,
  state.geosid,
  levelFor,
  effectiveRefGeosid,
]);

// Reset auto-select guard whenever the theme changes so the next payload
// load triggers a fresh best-code selection.
useEffect(() => {
  autoSelectThemeRef.current = null;
}, [state.theme]);

// Auto-select the variable with the highest focal value — categorical themes.
// csPayload.categories includes t_code + focal_pct per category.
useEffect(() => {
  if (!csPayload?.categories?.length) return;
  if (autoSelectThemeRef.current === state.theme) return;
  autoSelectThemeRef.current = state.theme;

  const best = csPayload.categories.reduce((a, b) =>
    (Number(b.focal_pct) || 0) > (Number(a.focal_pct) || 0) ? b : a
  );

  if (best.t_code && best.t_code !== state.t_code) {
    const found = codeOptions.find((c) => c.t_code === best.t_code);
    dispatch({
      type: "setCode",
      t_code: best.t_code,
      codeLabel: found?.t_name ?? best.t_name ?? best.t_code,
      codeLevel: found?.t_level ?? null,
    });
  }
}, [csPayload]);

// Auto-select the variable with the highest focal value — ordinal themes.
// osPayload.categories contains t_name labels; match back via codeOptions.
useEffect(() => {
  if (!osPayload?.focal?.length) return;
  if (!codeOptions?.length) return;
  if (autoSelectThemeRef.current === state.theme) return;
  autoSelectThemeRef.current = state.theme;

  const focalNums = osPayload.focal.map((v) =>
    Number.isFinite(Number(v)) ? Number(v) : -Infinity
  );
  const maxIdx = focalNums.indexOf(Math.max(...focalNums));

  if (maxIdx >= 0 && maxIdx < osPayload.categories.length) {
    const bestName = osPayload.categories[maxIdx];
    const found = codeOptions.find((c) => c.t_name === bestName);
    if (found && found.t_code !== state.t_code) {
      dispatch({
        type: "setCode",
        t_code: found.t_code,
        codeLabel: found.t_name ?? found.t_code,
        codeLevel: found.t_level ?? null,
      });
    }
  }
}, [osPayload, codeOptions]);

// NOTE: valueMode is no longer force-normalized when the variable's nc-ness
// changes.  state.valueMode holds the user's preference; effectiveValueMode
// (derived above) governs display.  The old normalization effect dispatched
// mid-cascade and triggered redundant full map refetches.

    const [ncRefValue, setNcRefValue] = useState(null);

    useEffect(() => {
      // Only fetch a non-count reference value when:
      // - this is a non-count theme OR a non-count category, AND
      // - we have refGeosid, year, and t_code.
      if (
        !isNonCountVariable ||
        !effectiveRefGeosid ||
        !state.year ||
        !state.t_code
      ) {
        setNcRefValue(null);
        return;
      }

      const controller = new AbortController();

      async function fetchNcRef() {
        try {
          const url = new URL(`${API_BASE}/api/nc-ref-value`);
          url.searchParams.set("geosid", effectiveRefGeosid);
          url.searchParams.set("year", String(state.year));
          url.searchParams.set("t_code", state.t_code);
          // Only reached for non-count variables, which are always raw.
          url.searchParams.set("value_mode", "raw");

          const res = await apiFetch(url.toString(), { signal: controller.signal });
          if (!res.ok) {
            console.error(
              "nc-ref-value failed:",
              res.status,
              await res.text()
            );
            setNcRefValue(null);
            return;
          }

          const payload = await res.json();

          // payload looks like { value, raw_value, denom_value }
          const v =
            payload && payload.value != null
              ? Number(payload.value)
              : null;

          setNcRefValue(Number.isFinite(v) ? v : null);
        } catch (err) {
          if (err.name !== "AbortError") {
            console.error("Error fetching nc-ref-value:", err);
            setNcRefValue(null);
          }
        }
      }

      fetchNcRef();

      return () => controller.abort();
    }, [
      isNonCountVariable,
      effectiveRefGeosid,
      state.year,
      state.t_code,
    ]);

  useEffect(() => {
  // Need at least focal geosid, year and t_code
  if (!state.geosid || !state.year || !state.t_code) {
    setSeriesPayload(null);
    return;
  }

  const controller = new AbortController();

  async function fetchSeries() {
    try {
      const url = new URL(`${API_BASE}/api/series`);
      url.searchParams.set("focal_geosid", state.geosid);
      if (effectiveRefGeosid) {
        url.searchParams.set("ref_geosid", effectiveRefGeosid);
      }
      url.searchParams.set("year", String(state.year));
      url.searchParams.set("t_code", state.t_code);
      url.searchParams.set("value_mode", effectiveValueMode);

      if (import.meta.env.DEV) console.log("[series] fetching", { focal_geosid: state.geosid, ref_geosid: effectiveRefGeosid, year: state.year, t_code: state.t_code, value_mode: effectiveValueMode });

      const res = await apiFetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error(
          "/api/series failed:",
          res.status,
          await res.text()
        );
        setSeriesPayload(null);
        return;
      }

      const data = await res.json();
      setSeriesPayload(data);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Error fetching series:", err);
        setSeriesPayload(null);
      }
    }
  }

  fetchSeries();
  return () => controller.abort();
}, [
  state.geosid,
  effectiveRefGeosid,
  state.year,
  state.t_code,
  effectiveValueMode,
]);


useEffect(() => {
  if (import.meta.env.DEV) {
    window.appDebug = { state, topicOptions, csPayload, osPayload };
  }
}, [state, topicOptions]);






  // --- 4. Ping DB button handler ---
  async function handlePing() {
    setPingLoading(true);
    setPingResult(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/ping`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPingResult(data);
    } catch (err) {
      console.error(err);
      setPingResult({ error: err.message });
    } finally {
      setPingLoading(false);
    }
  }

  return (
    <AppShell
      header={{ height: 48 }}
      navbar={{
        width: searchColWidth,
        breakpoint: "sm",
        collapsed: { desktop: !searchColOpen, mobile: !searchColOpen },
      }}
    >
      {/* ── Header ── */}
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Group gap={8} align="baseline" wrap="nowrap">
              <Title
                order={4}
                style={{
                  fontFamily: "'Lora', Georgia, 'Times New Roman', serif",
                  fontWeight: 700,
                  fontSize: "1.75rem",
                  lineHeight: 1.15,
                  letterSpacing: "0.02em",
                  color: colorScheme === "dark" ? COLOR_BRAND_DARK : COLOR_BRAND,
                }}
              >UNI·CEN</Title>
              <Text size="md" c="dimmed" visibleFrom="sm" style={{ whiteSpace: "nowrap" }}>Canadian Census Observatory</Text>
            </Group>
          </Group>

          <Group gap="xs">
            <Button
              variant={activePage === "map" ? "filled" : "subtle"}
              size="xs"
              onClick={() => setActivePage("map")}
            >Map</Button>
            <Button
              variant={activePage === "docs" ? "filled" : "subtle"}
              size="xs"
              onClick={() => setActivePage("docs")}
            >Documentation</Button>
            <Button
              variant={activePage === "about" ? "filled" : "subtle"}
              size="xs"
              onClick={() => setActivePage("about")}
            >About</Button>
            <Divider orientation="vertical" style={{ height: 38, alignSelf: "center" }} />
            <ActionIcon
              variant="subtle"
              onClick={toggleColorScheme}
              title={colorScheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {colorScheme === "dark" ? <IconSun size={20} /> : <IconMoon size={20} />}
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              onClick={() => setShowHelpOverlay((o) => !o)}
              title="Show interface guide"
            >
              <IconInfoCircle size={20} />
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>

      {/* ── Search column (left) ── */}
      <AppShell.Navbar p="xs">
        <ResizeHandle
          side="right"
          currentWidth={searchColWidth}
          onResize={setSearchColWidth}
          onCollapse={() => setSearchColOpen(o => !o)}
        />
        {/* The panel's own close control. The map-edge filter button brings it
            back; the resize handle also collapses on a click without a drag. */}
        <AppShell.Section>
          <Group justify="space-between" wrap="nowrap" mb={4}>
            <Text size="sm" fw={700}>Select variable, level and year</Text>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => setSearchColOpen(false)}
              title="Hide the selector panel"
              style={{ color: "var(--mantine-color-blue-6)" }}
            >
              <FaIcon icon={faCircleChevronLeft} size={16} />
            </ActionIcon>
          </Group>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea}>
          <Stack gap="sm">

            {/* Select variable */}
            <div ref={helpVariableRef}>
              <Text size="xs" c="dimmed" mb={4}>
                Select a theme and then a variable within that theme. Not all themes and variables exist in all years. Only available combinations will be shown. 
              </Text>
              <Select
                label="Theme"
                size="xs"
                searchable
                value={state.theme || null}
                onChange={(value) => {
                  if (!value) return;
                  const opt = topicOptions.find((o) => o.value === value);
                  dispatch({ type: "setTheme", theme: value, themeLabel: opt?.label ?? value, themeType: opt?.t_type ?? null });
                }}
                data={topicOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
                placeholder="Select theme…"
                nothingFoundMessage="No themes found"
              />

              <Select
                label="Variable"
                size="xs"
                mt="xs"
                searchable
                allowDeselect={false}
                value={state.t_code || null}
                // onOptionSubmit, not onChange: Mantine skips onChange when the
                // picked value equals the current one, and re-picking the shown
                // fallback is how the user adopts it as the intended variable.
                onOptionSubmit={(value) => {
                  if (!value) return;
                  const selected = codeOptions.find((c) => c.t_code === value);
                  dispatch({ type: "setCode", t_code: value, codeLabel: selected?.t_name ?? value, codeLevel: selected?.t_level ?? null, intended: true });
                }}
                onChange={() => {}}
                data={[...codeOptions]
                  .sort((a, b) =>
                    (a.t_name ?? a.t_code).localeCompare(b.t_name ?? b.t_code, "en", { sensitivity: "base" })
                  )
                  .map((c) => ({ value: c.t_code, label: c.t_name ?? c.t_code }))}
                placeholder={codeOptions.length === 0
                  ? (state.level && state.theme && state.year ? "Loading…" : "Select theme and year first")
                  : "Select variable…"}
                disabled={codeOptions.length === 0}
                nothingFoundMessage="No variables found"
              />
              {codeFallback && (
                <Text size="xs" c="dimmed" mt={4}>
                  {state.intendedLabel} is not tabulated for {LEVEL_NAME[state.level]} in {state.year}.
                  Showing {state.codeLabel} until a year that carries it is selected.
                </Text>
              )}

              {/* Level sits between Variable and Year: the year list depends on
                  it, and the geography search below it is scoped by it. Only
                  levels carrying the current variable in the current year are
                  enabled, so a switch never loses either. Switching clears the
                  selected geographies — their units belong to the old level. */}
              <Text size="xs" fw={600} mt="xs" mb={2}>Level</Text>
              <SegmentedControl
                className="level-control"
                size="xs"
                fullWidth
                color="blue"
                value={state.level ? String(state.level) : null}
                onChange={(v) => {
                  const level = Number(v);
                  if (!level || level === state.level) return;
                  clearPlace();
                  clearRef();
                  dispatch({ type: "setLevel", level });
                }}
                data={[1, 2, 3, 4, 5].map((lv) => ({
                  value: String(lv),
                  label: LEVEL_LABEL[lv].toUpperCase(),
                  disabled: codeLevels.length > 0 && !codeLevels.includes(lv),
                }))}
              />
              <Text size="xs" c="dimmed" mt={4}>
                {state.geosid || effectiveRefGeosid
                  ? "Changing level clears the selected geographies."
                  : `Showing all ${LEVEL_NAME[state.level] ?? LEVEL_LABEL[state.level] ?? "areas"}.${codeLevels.length > 0 && codeLevels.length < 5 ? ` Greyed levels do not carry this variable in ${state.year}.` : ""}`}
              </Text>

              {/* Year stays a pulldown. The button beside it opens the coverage
                  strip, which answers what the pulldown cannot: for this
                  variable, which census years exist at all. */}
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: "var(--mantine-spacing-xs)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    label="Year"
                    size="xs"
                    searchable
                    value={state.year?.toString() || null}
                    onChange={(value) => { if (value) changeYear(parseInt(value, 10)); }}
                    data={themeYears.map(y => ({ value: y.toString(), label: y.toString(), dim: !availableYearSet.has(y) }))}
                    renderOption={({ option }) => (
                      <Text size="xs" c={option.dim ? "dimmed" : undefined}>
                        {option.label}{option.dim ? " \u00b7 variable not tabulated" : ""}
                      </Text>
                    )}
                    placeholder="No years available"
                    disabled={geoYears.length === 0 && yearOptions.length === 0}
                    nothingFoundMessage="No years found"
                  />
                </div>
                <ActionIcon
                  ref={yearBtnRef}
                  size={30}
                  variant={yearCoverageOpen ? "filled" : "default"}
                  disabled={codeYears.census.length === 0}
                  onClick={() => {
                    const btn = yearBtnRef.current;
                    const map = helpMapRef.current;
                    if (btn && map) {
                      const b = btn.getBoundingClientRect();
                      const m = map.getBoundingClientRect();
                      // Align the strip's AXIS LINE with the button's centre --
                      // the line is what the button is "on", not the panel box.
                      // Panel border (1) + padding-top (8) sit above the strip.
                      const axisOffset = 1 + 8 + COVERAGE_AXIS_Y;
                      const raw = b.top - m.top + b.height / 2 - axisOffset;
                      setCoverageTop(Math.max(12, Math.min(raw, m.height - 120)));
                    }
                    setYearCoverageOpen((o) => !o);
                  }}
                  title="Show which years have data for this variable"
                  style={{ flexShrink: 0 }}
                >
                  <FaIcon icon={faCalendar} size={15} />
                </ActionIcon>
              </div>
              {coverageSummary && (
                <Text size="xs" c="dimmed" mt={5}>{coverageSummary}</Text>
              )}
            </div>

            {/*<Divider />*>}

            {/* Focal geography */}
            <div ref={helpGeoSearchRef}>
              <Text size="sm" fw={600} mb={4}>Select primary geography</Text>
              <Text size="xs" c="dimmed" mb={4}>
                Enter a place name, postal code to find a census tract, or census geography id code (geosid)
              </Text>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    size="xs"
                    placeholder="Enter place name, postal code, or geosid…"
                    searchable
                    clearable
                    allowDeselect={false}
                    value={
                      state.geosid
                        ? (optionIndexFor(geoOptions, state.geosid, state.year) >= 0
                            ? String(optionIndexFor(geoOptions, state.geosid, state.year))
                            : "__selected__")
                        : null
                    }
                    searchValue={geoSearch}
                    onSearchChange={setGeoSearch}
                    onChange={(val) => {
                      if (!val) { clearPlace(); return; }
                      if (val === "__selected__") return;
                      const found = geoOptions[parseInt(val, 10)];
                      if (found) selectSearchEntry(found, "focal");
                    }}
                    data={[
                      ...(state.geosid && optionIndexFor(geoOptions, state.geosid, state.year) < 0
                        ? [{ value: "__selected__", label: selectedGeoLabel || state.geosid }]
                        : []),
                      ...geoOptions.map((g, i) => ({ value: String(i), label: geoOptionLabel(g.label, g.geosid) })),
                    ]}
                    filter={({ options }) => options}
                    nothingFoundMessage={geoSearch.trim() ? geoStatus : "Type to search…"}
                    comboboxProps={{ zIndex: 1000 }}
                  />
                </div>
                <ActionIcon
                  size={28}
                  title="Zoom map to focal geography"
                  disabled={!state.geosid}
                  onClick={() => setFocalZoomSeq(s => s + 1)}
                  style={{
                    borderRadius: 6,
                    flexShrink: 0,
                    backgroundColor: state.geosid ? seriesColors(colorScheme).focal : undefined,
                    color: state.geosid ? "#ffffff" : undefined,
                    border: "none",
                  }}
                >
                  <IconFocus2 size={15} />
                </ActionIcon>
              </div>
            </div>

            {/*<Divider />*/}

            {/* Reference geography */}
            <div ref={helpRefGeoRef}>
              <Text size="sm" fw={600} mb={4}>Select comparison geography</Text>
              <Text size="xs" c="dimmed" mb={4}>
                Tip: Shift+click a map area to set or clear it as the comparison.
              </Text>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    size="xs"
                    placeholder="Enter place name, postal code, or geosid…"
                    searchable
                    clearable
                    allowDeselect={false}
                    value={
                      state.refGeosid
                        ? (optionIndexFor(refGeoOptions, state.refGeosid, state.year) >= 0
                            ? String(optionIndexFor(refGeoOptions, state.refGeosid, state.year))
                            : "__ref_selected__")
                        : null
                    }
                    searchValue={refSearch}
                    onSearchChange={setRefSearch}
                    onChange={(val) => {
                      if (!val) { clearRef(); return; }
                      if (val === "__ref_selected__") return;
                      const found = refGeoOptions[parseInt(val, 10)];
                      if (found) selectSearchEntry(found, "ref");
                    }}
                    data={[
                      // Sentinel: keep the explicit user selection visible when not in search results
                      ...(state.refGeosid && optionIndexFor(refGeoOptions, state.refGeosid, state.year) < 0
                        ? [{ value: "__ref_selected__", label: selectedRefLabel || state.refLabel || state.refGeosid }]
                        : []),
                      ...refGeoOptions.map((g, i) => ({ value: String(i), label: geoOptionLabel(g.label, g.geosid) })),
                    ]}
                    filter={({ options }) => options}
                    nothingFoundMessage={refSearch.trim() ? refGeoStatus : "Enter place name, postal code, or geosid…"}
                    comboboxProps={{ zIndex: 1000 }}
                  />
                </div>
                <ActionIcon
                  size={28}
                  title="Zoom map to comparison geography"
                  disabled={!effectiveRefGeosid}
                  onClick={() => setRefZoomSeq(s => s + 1)}
                  style={{
                    borderRadius: 6,
                    flexShrink: 0,
                    backgroundColor: effectiveRefGeosid ? seriesColors(colorScheme).ref : undefined,
                    color: effectiveRefGeosid ? "#ffffff" : undefined,
                    border: "none",
                  }}
                >
                  <IconFocus2 size={15} />
                </ActionIcon>
              </div>
            </div>

            {/*<Divider />*>}

            {/* Toggles */}
            <div ref={helpDisplayOptsRef}>
              <Text size="sm" fw={600} mb={4}>Display options</Text>
              {/* A segmented control rather than a switch: the switch signalled
                  "unavailable" by dimming its own label to #adb5bd (2.07:1), which
                  made the *current* value the least readable text in the panel.
                  Here the disabled half keeps full-contrast text and carries a lock. */}
              <SegmentedControl
                size="xs"
                fullWidth
                color="blue"
                value={effectiveValueMode === "percent" ? "percent" : "raw"}
                onChange={(value) => dispatch({ type: "setValueMode", valueMode: value })}
                data={[
                  { value: "raw", label: "Absolute" },
                  {
                    value: "percent",
                    disabled: isNonCountVariable,
                    label: (
                      <Group gap={5} justify="center" wrap="nowrap">
                        {isNonCountVariable && <IconLock size={12} stroke={2.2} />}
                        <span>Percent</span>
                      </Group>
                    ),
                  },
                ]}
              />
              {isNonCountVariable && (
                <Text size="xs" c="dimmed" mt={4}>Percent is unavailable for non-count measures.</Text>
              )}

              {/*<Switch
                size="xs"
                mt="xs"
                label={`Scale: ${state.useLogScale && state.valueMode !== "percent" ? "Log" : "Linear"}`}
                checked={state.useLogScale}
                disabled={state.valueMode === "percent"}
                onChange={(e) => dispatch({ type: "setLogScale", useLogScale: e.currentTarget.checked })}
                styles={{ track: { backgroundColor: state.useLogScale ? "var(--mantine-color-red-6)" : "var(--mantine-color-blue-6)", borderColor: state.useLogScale ? "var(--mantine-color-red-6)" : "var(--mantine-color-blue-6)" } }}
              />
              {state.valueMode === "percent" && (
                <Text size="xs" c="dimmed" mt={2}>Log scale available for non-count variables only.</Text>
              )}
              */}

              <Switch
                size="xs"
                mt="xs"
                label="Base map"
                withThumbIndicator={false}
                checked={showBasemap}
                onChange={(e) => setShowBasemap(e.currentTarget.checked)}
              />
            </div>

          </Stack>
        </AppShell.Section>

        {/* Panel foot — reclaims the 22px footer bar the app used to spend on
            three rarely-read strings. The basemap credit lives here too; see
            the map's fallback credit for what happens when this panel is
            collapsed (ODbL and CARTO both require the attribution to remain
            visible, so it can never simply disappear). */}
        <AppShell.Section>
          <Divider mb={8} />
          <Text c="dimmed" style={{ fontSize: 9, lineHeight: 1.45 }}>
            App {APP_VERSION} · updated {APP_LAST_UPDATED}<br />
            Census data updated {DATA_LAST_UPDATED}<br />
            Base map ©{" "}
            <Anchor c="dimmed" underline="always" style={{ fontSize: 9 }} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</Anchor>
            {" "}contributors, ©{" "}
            <Anchor c="dimmed" underline="always" style={{ fontSize: 9 }} href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</Anchor>
            {" · "}
            <Anchor c="dimmed" underline="always" style={{ fontSize: 9 }} href="https://leafletjs.com/" target="_blank" rel="noreferrer">Leaflet</Anchor>
            <br />
            Historical boundaries 1851–1941 after{" "}
            <Anchor c="dimmed" underline="always" style={{ fontSize: 9 }} href="https://doi.org/10.5683/SP2/IQ7E0X" target="_blank" rel="noreferrer">Historical Atlas of Canada, Territorial Evolution</Anchor>
            {" "}(CC BY-NC 4.0)
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      {/* ── Main: map or static pages ── */}
      <AppShell.Main style={{
        paddingTop: "var(--app-shell-header-height)",
        paddingLeft: searchColOpen ? "var(--app-shell-navbar-width)" : 0,
      }}>
        {activePage === "map" ? (
          // position:relative scopes the floating cards to the map area.
          // Explicit height prevents the absolutely-positioned floating cards
          // from creating a scrollable overflow region.
          <div ref={helpMapRef} style={{
            position: "relative",
            height: "calc(100vh - var(--app-shell-header-height))",
            overflow: "hidden",
            display: "flex",
          }}>
          <div style={{ position: "relative", flex: 1, minWidth: 0, height: "100%" }}>
          <ChoroplethMap
            ref={helpLegendRef}
            geometry={mapView?.geometry ?? null}
            values={mapView?.values ?? null}
            level={mapView?.level ?? null}
            year={mapView?.year ?? null}
            provincesFC={provincesFC}
            ctCmaNames={ctCmaNames}
            theme={state.theme}
            themeLabel={state.themeLabel ?? ""}
            code={state.t_code}
            codeLabel={state.codeLabel ?? ""}
            valueMode={effectiveValueMode}
            useLogScale={logForNc}
            showBasemap={showBasemap}
            layoutKey={`${searchColOpen}-${searchColWidth}-${plotsOpen}-${effectivePlotsWidth}`}
            showAttribution={!searchColOpen}
            selectorsOpen={searchColOpen}
            plotsOpen={plotsOpen}
            onOpenSelectors={() => setSearchColOpen(true)}
            onOpenPlots={() => setPlotsOpen(true)}
            // Highlight (and zoom to) the selection only once the map DRAWS the
            // layer of the selected YEAR (mapView, not geometryPayload: the map
            // waits for matching values before it swaps layers). Before 1981 a code names a different
            // place in each census, so applying 1891's geosid to the 1861 layer
            // still on screen would outline — and zoom to — the wrong unit
            // (3540002 is Barton in 1861 and Beckwith in 1891).
            selectedGeosid={mapView?.year === state.year ? state.geosid : null}
            selectedRefGeosid={mapView?.year === state.year ? effectiveRefGeosid : null}
            onSelectGeosid={(geosid, geoname) => {
              dispatch({ type: "setPlace", geosid });
              // Look up the geosid in the geos table so the Select label matches
              // the dropdown format exactly, preventing a search/render cycle.
              apiFetch(`${API_BASE}/api/geos?q=${encodeURIComponent(geosid)}`)
                .then(r => r.ok ? r.json() : [])
                .then(matches => {
                  // Several entries can share a geosid (one per name era);
                  // take the one whose span holds the current year.
                  const y = stateRef.current.year;
                  const same = matches.filter(g => String(g.geosid) === String(geosid));
                  // No entry holding the year: the code belongs to another
                  // place in every listed era, so keep the map's own name.
                  const found = same.find(g => g.year_min == null || (y >= g.year_min && y <= g.year_max)) ?? null;
                  const label = found ? geoOptionLabel(found.label, found.geosid) : (geoname || geosid);
                  if (found) setGeoOptions(matches);
                  setSelectedGeoLabel(label);
                  setGeoSearch(label);
                })
                .catch(() => {
                  setSelectedGeoLabel(geoname || geosid);
                  setGeoSearch("");
                });
            }}
            onSelectRefGeosid={(geosid, geoname) => {
              // Shift+click toggle: re-selecting the current comparison clears it.
              if (state.refGeosid && String(state.refGeosid) === String(geosid)) {
                clearRef();
                return;
              }
              dispatch({ type: "setRefPlace", geosid, label: geoname || geosid });
              // Same label bookkeeping as the focal handler: resolve the
              // dropdown-format label so the comparison Select displays it.
              apiFetch(`${API_BASE}/api/geos?q=${encodeURIComponent(geosid)}`)
                .then(r => r.ok ? r.json() : [])
                .then(matches => {
                  const y = stateRef.current.year;
                  const same = matches.filter(g => String(g.geosid) === String(geosid));
                  const found = same.find(g => g.year_min == null || (y >= g.year_min && y <= g.year_max)) ?? null;
                  const label = found ? geoOptionLabel(found.label, found.geosid) : (geoname || geosid);
                  if (found) {
                    setRefGeoOptions(matches);
                    dispatch({ type: "setRefPlace", geosid, label: found.label });
                  }
                  setSelectedRefLabel(label);
                  setRefSearch(label);   // see the focal handler: keep Mantine's text in sync
                })
                .catch(() => {
                  setSelectedRefLabel(geoname || geosid);
                  setRefSearch("");
                });
            }}
            height="calc(100vh - var(--app-shell-header-height))"
            focalZoomSeq={focalZoomSeq}
            refZoomSeq={refZoomSeq}
            refPolygon={refPolygon}
          />

          {/* ── Year coverage flyout ──
              Flies out sideways from the button beside the Year field, across
              almost the full width of the map. Wide, because the buttons need
              the room: at sidebar width the tightest pair of census years
              collides. Carries nothing but the strip — the sidebar already
              states how many years the variable has. */}
          {yearCoverageOpen && (
            <div
              style={{
                position: "absolute",
                left: 12,
                right: 20,
                top: coverageTop,
                zIndex: 1200,
                display: "flex",
                alignItems: "center",
              }}
            >
              {/* Pointer back to the button that opened it. The second path
                  paints over the panel's own left border so the two read as
                  one shape rather than a triangle stuck to a box. */}
              <svg
                width="9"
                height="18"
                viewBox="0 0 9 18"
                style={{ display: "block", marginRight: -1, flexShrink: 0, position: "relative", zIndex: 1 }}
                aria-hidden="true"
              >
                <path d="M9 0L1 9L9 18Z" fill="var(--mantine-color-body)" stroke="var(--mantine-color-default-border)" strokeWidth="1" />
                <path d="M9 1V17" stroke="var(--mantine-color-body)" strokeWidth="2" />
              </svg>

              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "var(--mantine-color-body)",
                  border: "1px solid var(--mantine-color-default-border)",
                  borderRadius: 10,
                  boxShadow: "rgba(0,0,0,0.22) 0 8px 28px 0",
                  padding: "8px 14px",
                  overflowX: "auto",
                }}
              >
                <YearCoverage
                  census={codeYears.census}
                  available={availableYears}
                  value={state.year}
                  onChange={(y) => changeYear(y)}
                  colorScheme={colorScheme}
                  width={coverageWidth}
                />
              </div>
            </div>
          )}

          </div>{/* end map column */}

          {/* ── Plots rail ── */}
          {plotsOpen && (
          <PlotsTray
            ref={plotsTrayRef}
            onToggle={() => setPlotsOpen(false)}
            width={effectivePlotsWidth}
            onResize={setPlotsWidth}
            colorScheme={colorScheme}
            themeLabel={state.themeLabel || state.theme}
            variableLabel={state.codeLabel}
            focalLabel={geoDisplayName(effectiveFocalLabel)}
            refLabel={geoDisplayName(effectiveRefLabel)}
            hasFocal={!!state.geosid}
            hasRef={!!effectiveRefGeosid}
            profile={
              <>
                {csPayload && !isNonCountVariable && (
                  <CatPlot data={csPayload} hasRef={!!effectiveRefGeosid} />
                )}
                {osPayload && !isNonCountVariable && (
                  <OrdPlot
                    data={{
                      categories: osPayload.categories,
                      focal: osPayload.focal,
                      ref: effectiveRefGeosid ? osPayload.ref : null,
                      focalLabel: geoDisplayName(effectiveFocalLabel) || "Focal geography",
                      refLabel: geoDisplayName(effectiveRefLabel) || "Comparison geography",
                      themeLabel: state.themeLabel || state.theme,
                      year: state.year,
                    }}
                  />
                )}
                {isNonCountVariable && ncRows?.length > 0 && (
                  <NCPlot
                    rows={ncRows}
                    focalGeosid={state.geosid}
                    refGeosid={effectiveRefGeosid}
                    focalLabel={geoDisplayName(effectiveFocalLabel)}
                    refLabel={geoDisplayName(effectiveRefLabel) || "Comparison geography"}
                    refValueOverride={ncRefValue}
                    themeLabel={state.themeLabel ?? ""}
                    codeLabel={state.codeLabel ?? ""}
                    useLogScale={false}
                    year={state.year}
                  />
                )}
                {!csPayload && !osPayload
                  && !(isNonCountVariable && ncRows?.length > 0) && (
                  <Text size="xs" c="dimmed" ta="center" py="sm">
                    Select a geography and variable to see data here.
                  </Text>
                )}
              </>
            }
            overTime={
              seriesPayload?.focal?.series?.length > 1 ? (
                <LongitudinalPlot
                  seriesPayload={seriesPayload}
                  valueMode={effectiveValueMode}
                  useLogScale={false}
                  censusYears={codeYears.census}
                />
              ) : (
                <Text size="xs" c="dimmed" ta="center" py="sm">
                  No longitudinal data available.
                </Text>
              )
            }
          />
          )}

          {showHelpOverlay && (
            <HelpOverlay
              steps={[
                { ref: helpVariableRef, title: "Theme, variable, level, and year", text: "Choose a census theme, a variable within it, the level of geography to map, and the year. The year list covers every census the theme exists in; years that do not tabulate your variable are dimmed. Choose one anyway and the map shows the theme's first variable, with a note under Variable, until you return to a year that carries yours. Greyed levels lack the variable in the chosen year, and changing level clears the selected geographies." },
                { ref: helpGeoSearchRef, title: "Search geography", text: "Find a place by name, postal code, or census geography id to focus the map on it. Picking a place at another level switches the level." },
                { ref: helpRefGeoRef, title: "Comparison geography", text: "Optionally pick a second geography to compare against the one you selected." },
                { ref: helpDisplayOptsRef, title: "Display options", text: "Switch between percent and absolute values, and toggle the base map on or off." },
                { ref: helpMapRef, title: "The map", text: "Shows the selected variable across the map's geographies, shaded by value. Click a geography to select it." },
                { ref: helpLegendRef, title: "Legend", text: "Shows how map shading maps to values, and how areas with no data are marked." },
                { ref: plotsTrayRef, title: "Plots", text: "The profile of the selected geography and its change over census years, side by side. Collapse the tray with the chevron to give the map its full height back." },
              ]}
              onClose={() => setShowHelpOverlay(false)}
            />
          )}
          </div>

        ) : (
          <React.Suspense fallback={null}>
            {activePage === "docs" ? <Documentation /> : <About />}
          </React.Suspense>
        )}
      </AppShell.Main>

    </AppShell>
  );
}
