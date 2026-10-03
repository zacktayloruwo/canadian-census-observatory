// src/ChoroplethMap.jsx
import React, { useEffect, useMemo, useRef, useState, forwardRef } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents, Pane, ZoomControl } from "react-leaflet";
import { useMantineColorScheme } from "@mantine/core";
import { faCanadianMapleLeaf } from "@fortawesome/free-brands-svg-icons";
import { faChartSimple, faFilter } from "@fortawesome/free-solid-svg-icons";
import { COLOR_FOCAL, COLOR_REF, COLOR_PROVINCE_BOUNDARY, HOVER_POPUP_DELAY_MS, COLOR_BRAND, CARTO_KEY, cartoTileUrl, DATA_LAST_UPDATED } from "./config";
import { apiFetch } from "./data/apiFetch";
import DataLoadingIndicator from "./DataLoadingIndicator";

// The /api/* URLs are answered in the browser by data/routes.js (see
// data/apiFetch.js); the origin only has to make them absolute.
const API_BASE = window.location.origin;

// Without a key CARTO serves watermarked tiles rather than an error, so nothing
// in the console or the network panel would otherwise say why the basemap looks
// wrong. Say it once, at startup.
// Guarded on the window rather than a module-level flag: dev re-evaluates this
// module on hot reload, which would otherwise repeat the warning each time.
if (!CARTO_KEY && typeof window !== "undefined" && !window.__cartoKeyWarned) {
  window.__cartoKeyWarned = true;
  console.warn(
    "[basemap] No VITE_CARTO_KEY set — CARTO will serve tiles stamped " +
    "\"API KEY REQUIRED\". Add the key to frontend/.env (see .env.example).",
  );
}

// Canvas-compatible "No data" hatch. The canvas renderer can't resolve SVG
// url(#...) fills, so we draw the same 8x8 hatch as the #noDataHatch pattern
// (kept for the legend swatch) onto an offscreen canvas once and hand Leaflet
// a CanvasPattern — ctx.fillStyle accepts it directly.
// Flags from census_spatial, carried by the bundles and the /api/geometry
// fallback as 0/1 (a bundle without them draws everything):
//  * in_canada = false: a jurisdiction not yet part of Canada that year. Not
//    drawn (project-lead decision 2026-09-11).
//  * is_placeholder: unenumerated "999" residual territory (the unorganized
//    north of Ontario and Quebec, the Territories). Drawn in the no-data
//    hatch so the map tiles the province, but never a unit: no tooltip, no
//    selection (decision 2026-09-12, replacing the earlier suppression).
const flagTrue = (v) => v === true || v === 1 || v === "1" || v === "true";
const flagFalse = (v) => v === false || v === 0 || v === "0" || v === "false";
function isSuppressedFeature(feature) {
  return flagFalse(feature?.properties?.in_canada);
}
const isPlaceholderFeature = (feature) => flagTrue(feature?.properties?.is_placeholder);
// Disputed territory (the 1881 Ontario-Manitoba dispute, from the Historical
// Atlas of Canada through the boundary pipeline): drawn as a grey diagonal
// hatch over the province overlay, never a unit (no hover, no click).
const isDisputedFeature = (feature) => flagTrue(feature?.properties?.disputed);
let disputedPattern = null;
function getDisputedPattern() {
  if (disputedPattern) return disputedPattern;
  try {
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = "#7a7a7a"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-2, 10); ctx.lineTo(10, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-2, 2); ctx.lineTo(2, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6, 10); ctx.lineTo(10, 6); ctx.stroke();
    disputedPattern = ctx.createPattern(c, "repeat");
  } catch {
    disputedPattern = "#9a9a9a";
  }
  return disputedPattern;
}

let noDataPattern = null;
function getNoDataPattern() {
  if (noDataPattern) return noDataPattern;
  try {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#a8c8e8";
    ctx.fillRect(0, 0, 8, 8);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.lineTo(8, 0);
    ctx.moveTo(-2, 2);
    ctx.lineTo(2, -2);
    ctx.moveTo(6, 10);
    ctx.lineTo(10, 6);
    ctx.stroke();
    noDataPattern = ctx.createPattern(c, "repeat");
  } catch {
    noDataPattern = "#a8c8e8";
  }
  return noDataPattern;
}

// --- Inferno palette helpers -------------------------------------------------

function infernoColor(t) {
  const x = Math.max(0, Math.min(1, t));

  // Light to Dark
  const stops = [
    [0.0, "#fbf976"],
    [0.15, "#e65136"],
    [0.35, "#b63655"],
    [0.55, "#88226a"],
    [0.75, "#550f6d"],
    [0.9, "#1f0c48"],
    [1.0, "#000004"],
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (x >= p0 && x <= p1) {
      const localT = (x - p0) / (p1 - p0);
      return interpolateHex(c0, c1, localT);
    }
  }
  return stops[stops.length - 1][1];
}

function interpolateHex(hex1, hex2, t) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return rgbToHex(r, g, b);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const h = x.toString(16);
        return h.length === 1 ? "0" + h : h;
      })
      .join("")
  );
}

// --- Map ref helper ----------------------------------------------------------
// Exposes the Leaflet map instance to the parent component via a ref.

function MapInit({ mapRef }) {
  const map = useMap();
  useEffect(() => { mapRef.current = map; }, [map]);
  return null;
}

// --- Background colour helper ------------------------------------------------

function MapBackground({ showBasemap }) {
  const map = useMap();
  useEffect(() => {
    map.getContainer().style.background = showBasemap ? "" : "#ffffff";
  }, [showBasemap, map]);
  return null;
}

// --- Layout resize helper ----------------------------------------------------
// Calls invalidateSize after panel open/close transitions complete (~300 ms).

function MapResizer({ layoutKey }) {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 350);
    return () => clearTimeout(id);
  }, [layoutKey, map]);
  return null;
}

// Builds a FontAwesome glyph as raw SVG. DOM API rather than innerHTML, so no
// markup from the icon data is ever parsed as HTML.
function faSvg(icon, size = 15, fill = "currentColor") {
  const [w, h, , , pathData] = icon.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", fill);
  for (const d of paths) {
    const pathEl = document.createElementNS(svgNS, "path");
    pathEl.setAttribute("d", d);
    svg.appendChild(pathEl);
  }
  return svg;
}

// --- Selection outline casing ------------------------------------------------
//
// A selection outline is drawn twice: a white casing underneath, the coloured
// core on top. No single colour stays legible across the whole inferno ramp --
// it spans nearly the full luminance range, and measured against its ten
// classes even pure white bottoms out at 1.66:1 (against the palest class)
// while the focal green and comparison magenta bottom out at 1.17 and 1.20.
// The pair is what carries it: the casing separates the line over the dark
// classes, the core over the light ones.
const CASING_COLOR = "#ffffff";
const CASING_EXTRA = 2;      // total, so 1px of casing shows on each side
const FOCAL_WEIGHT = 4;
const REF_WEIGHT = 3;

function outlineStyle(color, weight) {
  return { fill: false, color, weight, opacity: 1, interactive: false };
}

// --- Generic Leaflet icon control -------------------------------------------
//
// Registered as a real Leaflet control rather than an absolutely-positioned
// overlay, so it inherits the zoom cluster's exact dimensions and takes its
// place in the corner's stacking order instead of guessing at offsets.
function IconControl({ icon, title, position, onClick }) {
  const map = useMap();
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEffect(() => {
    const Ctl = L.Control.extend({
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", container);
        btn.title = title;
        btn.href = "#";
        btn.setAttribute("role", "button");
        btn.style.cssText =
          "display:flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer;";
        btn.appendChild(faSvg(icon));
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          onClickRef.current?.();
        });
        return container;
      },
    });
    const ctrl = new Ctl({ position });
    ctrl.addTo(map);
    return () => ctrl.remove();
  }, [map, icon, title, position]);

  return null;
}

// --- National zoom button ----------------------------------------------------

function ZoomToNational({ center, zoom }) {
  const map = useMap();

  useEffect(() => {
    const NationalControl = L.Control.extend({
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", container);
        btn.title = "Zoom to national scale";
        btn.href = "#";
        btn.style.cssText =
          "display:flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer;";
        const [w, h, , , pathData] = faCanadianMapleLeaf.icon;
        const paths = Array.isArray(pathData) ? pathData : [pathData];
        // Build the SVG via DOM API (avoids innerHTML / XSS risk)
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("fill", COLOR_BRAND);
        for (const d of paths) {
          const pathEl = document.createElementNS(svgNS, "path");
          pathEl.setAttribute("d", d);
          svg.appendChild(pathEl);
        }
        btn.appendChild(svg);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          map.setView(center, zoom);
        });
        return container;
      },
    });
    const ctrl = new NationalControl({ position: "topright" });
    ctrl.addTo(map);
    return () => ctrl.remove();
  }, [map]);

  return null;
}

// --- Viewport reporter ---------------------------------------------------------
// Reports the visible extent ([west, south, east, north]) once on mount and
// after every pan or zoom, so App can load census tracts for the CMAs in view.

function ViewportReporter({ onChange }) {
  const map = useMap();
  const report = () => {
    const b = map.getBounds();
    onChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  };
  useMapEvents({ moveend: report });
  useEffect(report, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// --- Zoom helper -------------------------------------------------------------

function ZoomToSelected({ geojson, selectedGeosid }) {
  const map = useMap();

  // Zoom only when the SELECTION changes, not when the geometry object does —
  // geometry gets a new identity on every (level, year) change, and refitting
  // then would yank the user's zoom/pan just for picking a different year.
  // lastZoomedRef records which geosid we already handled; it's only set once
  // the selection's features are on hand, so a selection made before its
  // geometry arrives still zooms once the features land.
  const lastZoomedRef = useRef(null);

  useEffect(() => {
    if (!selectedGeosid) {
      lastZoomedRef.current = null; // clearing the selection re-arms the zoom
      return;
    }
    if (lastZoomedRef.current === selectedGeosid) return;
    if (!geojson) return;

    const features = geojson.features || [];
    const selectedFeatures = features.filter(
      (f) => f?.properties?.geosid === selectedGeosid
    );

    if (selectedFeatures.length === 0) return;

    const tempLayer = L.geoJSON(selectedFeatures);
    const bounds = tempLayer.getBounds();

    if (bounds && bounds.isValid && bounds.isValid()) {
      // Already fully on screen (typically a polygon just clicked): leave the
      // view alone. Otherwise fit it, capping the zoom-in at level 10 or the
      // current zoom, whichever is closer, so the cap never forces a zoom-out
      // (it used to pull a zoomed-in map back to 10 on every click). The fit
      // still zooms out when the polygon is too big to show at this zoom.
      if (!map.getBounds().contains(bounds)) {
        map.fitBounds(bounds, {
          maxZoom: Math.max(10, map.getZoom()),
          padding: [20, 20],
        });
      }
      lastZoomedRef.current = selectedGeosid;
    }

  }, [geojson, selectedGeosid, map]);

  return null;
}

// --- Button-triggered zoom ---------------------------------------------------
// Fires fitBounds only when `seq` increments (button press), not on every
// render.  geojson / geosid are read via refs so they don't need to be deps.

// overrideGeojson: a pre-fetched Feature/FeatureCollection that takes priority
// over searching featureCollection by geosid (used for the ref geography which
// may be at a different level and therefore absent from the current tile layer).
function ZoomOnRequest({ geojson, geosid, seq, overrideGeojson }) {
  const map = useMap();
  const geojsonRef  = useRef(geojson);
  const geosidRef   = useRef(geosid);
  const overrideRef = useRef(overrideGeojson);
  geojsonRef.current  = geojson;
  geosidRef.current   = geosid;
  overrideRef.current = overrideGeojson;

  useEffect(() => {
    if (!seq) return;

    // Prefer the pre-fetched polygon if available
    const override = overrideRef.current;
    if (override) {
      const fc = override.type === "FeatureCollection"
        ? override
        : { type: "FeatureCollection", features: [override] };
      const bounds = L.geoJSON(fc).getBounds();
      if (bounds?.isValid()) map.fitBounds(bounds, { maxZoom: 10, padding: [20, 20] });
      return;
    }

    // Fall back to searching the current tile layer
    const gj  = geojsonRef.current;
    const gid = geosidRef.current;
    if (!gj || !gid) return;
    const features = (gj.features || []).filter(
      (f) => f?.properties?.geosid === gid
    );
    if (!features.length) return;
    const bounds = L.geoJSON(features).getBounds();
    if (bounds?.isValid()) map.fitBounds(bounds, { maxZoom: 10, padding: [20, 20] });
  }, [seq, map]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// --- Main component ----------------------------------------------------------

const ChoroplethMap = forwardRef(function ChoroplethMap({
  geometry,      // FeatureCollection — static per (level, year); properties: geosid/geoname/prname
  // Changes when the features of a (level, year) grow: census tracts arrive
  // per CMA as the map moves, and the layer must remount to draw them.
  geometryKey = "",
  onViewportChange, // ([west, south, east, north]) after each pan/zoom
  values,        // Map<geosid, displayValue> — swapped on variable/mode change, layer persists
  level,
  year,
  theme,
  themeLabel,
  code,
  codeLabel,
  valueMode, // "raw" | "percent"
  useLogScale,
  selectedGeosid,
  selectedRefGeosid,
  onSelectGeosid,
  onSelectRefGeosid,
  showBasemap = true,
  layoutKey,
  height = "600px",
  focalZoomSeq = 0,
  refZoomSeq   = 0,
  refPolygon   = null,
  provincesFC  = null, // province overlay FC expanded from the year's topology
                       // bundle by App; when present, no /api/boundaries fetch
  // { <ct geosid>: "<CMA name>" } while the tract level is showing, null
  // otherwise. Tract popups name their metro area instead of their province,
  // and the TopoJSON feature properties carry prname only.
  ctCmaNames = null,
  // The basemap credit normally lives in the selector panel. When that panel is
  // collapsed it has nowhere to go, and ODbL/CARTO both require it to stay
  // visible — so it comes back into the map corner instead.
  showAttribution = false,
  // The panel toggles are open-only affordances: each appears on the map edge
  // where its panel will appear, and disappears once that panel is open (the
  // panel carries its own close control).
  selectorsOpen = true,
  plotsOpen = true,
  onOpenSelectors,
  onOpenPlots,
}, legendRef) {
  const { colorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";

  // --- Provincial boundary overlay -----------------------------------------
  const [provinceBoundaries, setProvinceBoundaries] = useState(null);

  useEffect(() => {
    if (!year) return;
    if (provincesFC) {
      setProvinceBoundaries(provincesFC);
      return;
    }
    let cancelled = false;
    apiFetch(`${API_BASE}/api/boundaries?level=5&year=${year}&v=${DATA_LAST_UPDATED}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (!cancelled && data) setProvinceBoundaries(data); })
      .catch((e) => console.error("[boundaries] fetch error:", e));
    return () => { cancelled = true; };
  }, [year, provincesFC]);

  // Suppressed polygons are dropped here, before styling, selection
  // outlines and zoom-to-selected see the collection.
  const featureCollection = useMemo(() => {
    if (!geometry || !geometry.features || geometry.features.length === 0) return null;
    const kept = geometry.features.filter((f) => !isSuppressedFeature(f));
    if (kept.length === 0) return null;
    return kept.length === geometry.features.length ? geometry : { ...geometry, features: kept };
  }, [geometry]);

  const hasData =
    featureCollection && featureCollection.features.length > 0;

  // Focal / comparison outline geometry for the selection-outline pane.
  // Derived from props so the outlines always track the current geometry —
  // no imperative z-order bookkeeping (see the pane comment below).
  const selectionOutlineFC = useMemo(() => {
    const pick = (gid) => {
      if (!gid || !featureCollection) return null;
      const feats = featureCollection.features.filter(
        (f) => String(f.properties?.geosid) === String(gid)
      );
      return feats.length ? { type: "FeatureCollection", features: feats } : null;
    };
    return { focal: pick(selectedGeosid), ref: pick(selectedRefGeosid) };
  }, [featureCollection, selectedGeosid, selectedRefGeosid]);

  const defaultAlpha = 0.7;
  const hoverAlpha = 1;

  // --- Build decile breaks in (optionally) transformed space -------------
  // Memoized: recomputed only when the values map (or transform mode) changes,
  // not on every render.
  // - decileTransBreaks: breaks in transformed space (for bin assignment)
  // - decileRawBreaks: breaks in raw value space (for legend labels)
  const { decileTransBreaks, decileRawBreaks, decilePalette, transformForBins } =
    useMemo(() => {
      const identity = (x) => x;
      const empty = {
        decileTransBreaks: null,
        decileRawBreaks: null,
        decilePalette: null,
        transformForBins: identity,
      };
      if (!values || values.size === 0) return empty;

      const useAsinh = useLogScale && valueMode === "raw";
      const transform = useAsinh ? (x) => Math.asinh(x) : identity;

      // Extract *only* numeric, non-missing values
      const entries = [];
      for (const v of values.values()) {
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
          const raw = Number(v);
          entries.push({ raw, t: transform(raw) });
        }
      }
      if (entries.length === 0) return { ...empty, transformForBins: transform };

      entries.sort((a, b) => a.t - b.t);
      const n = entries.length;
      const transBreaks = [];
      const rawBreaks = [];
      for (let k = 1; k <= 9; k++) {
        const p = k / 10;
        const idx = Math.floor(p * (n - 1));
        transBreaks.push(entries[idx].t);
        rawBreaks.push(entries[idx].raw);
      }

      const palette = [];
      for (let i = 0; i < 10; i++) {
        const t = (i + 0.5) / 10; // midpoints 0.05, 0.15, ..., 0.95
        palette.push(infernoColor(t));
      }

      if (import.meta.env.DEV) console.log("[ChoroplethMap] decileRawBreaks:", rawBreaks);

      return {
        decileTransBreaks: transBreaks,
        decileRawBreaks: rawBreaks,
        decilePalette: palette,
        transformForBins: transform,
      };
    }, [values, useLogScale, valueMode]);

  // --- Layer ref tracking (for imperative style updates) -------------------

  // Maps geosid → array of Leaflet layers (one geosid can span multiple polygons)
  const layersByGeosid = useRef({});
  // Tracks the previous selection so we can un-highlight old layers
  const prevSelected = useRef({ focal: null, ref: null });
  // Holds the latest styleFn so the selection-change effect can call it
  const styleFnRef = useRef(null);
  // Hover tooltip state — driven by React, not Leaflet popups
  const hoverTimerRef = useRef(null);
  const mapRef        = useRef(null);
  const [hoverTooltip, setHoverTooltip] = useState(null); // { html, x, y } | null

  // Layer identity is the geometry identity: a level or year change, or more
  // census tracts arriving, remounts the GeoJSON layer. Variable / mode
  // changes restyle in place.
  const mapKey = `${level ?? "n"}-${year ?? "n"}-${geometryKey}`;

  // Live context for event handlers bound at layer mount: handlers read the
  // current values/labels through this ref, so tooltips stay correct across
  // variable changes without rebinding events.
  const hoverCtxRef = useRef({});
  // Selection callbacks ride the same ref: click handlers are bound once at
  // layer mount, and calling the mount-time prop directly would capture stale
  // state in App's closures (e.g. the Shift+click toggle reading an outdated
  // refGeosid).
  hoverCtxRef.current = { values, valueMode, theme, themeLabel, code, codeLabel, ctCmaNames, onSelectGeosid, onSelectRefGeosid };

  // Clear layer registry and any pending hover whenever the GeoJSON remounts
  useEffect(() => {
    layersByGeosid.current = {};
    clearTimeout(hoverTimerRef.current);
    setHoverTooltip(null);
  }, [mapKey]);

  // --- Styling function -----------------------------------------------------

  const styleFn = (feature) => {
    const props = feature.properties || {};
    const gid = props.geosid;
    const rawVal = values ? values.get(String(gid)) : null;
    const isFocal = selectedGeosid && gid === selectedGeosid;
    // Focal takes priority over ref if same polygon
    const isRef = !isFocal && selectedRefGeosid && gid === selectedRefGeosid;

    const isMissing =
      rawVal === null ||
      rawVal === undefined ||
      !Number.isFinite(Number(rawVal));

    if (isDisputedFeature(feature)) {
      return { fillColor: getDisputedPattern(), fillOpacity: 1, weight: 1, color: "#7a7a7a", opacity: 0.9, dashArray: "4 3", smoothFactor: 1 };
    }
    // Base style for NA / no numeric value; placeholder residuals take it
    // whatever the tables hold for their code.
    if (
      isMissing ||
      isPlaceholderFeature(feature) ||
      !decileTransBreaks ||
      !decilePalette
    ) {
      const baseStyle = {
        fillColor: getNoDataPattern(),
        weight: 0.5,
        color: "#ffffff",
        fillOpacity: 1,
        opacity: 0.8,
        smoothFactor: 1,
      };

      if (isFocal) {
        return { ...baseStyle, color: COLOR_FOCAL, weight: 6, opacity: 1 };
      }
      if (isRef) {
        return { ...baseStyle, color: COLOR_REF, weight: 4, opacity: 1 };
      }
      return baseStyle;
    }

    const vRaw = Number(rawVal);
    const vT = transformForBins(vRaw);

    let bin = 9;
    for (let i = 0; i < decileTransBreaks.length; i++) {
      if (vT <= decileTransBreaks[i]) {
        bin = i;
        break;
      }
    }

    const fill = decilePalette[bin];

    const baseStyle = {
      fillColor: fill,
      weight: 0.5,
      color: "#ffffff",
      opacity: 0.8,
      fillOpacity: defaultAlpha,
      smoothFactor: 1,
    };

    if (isFocal) {
      return { ...baseStyle, color: COLOR_FOCAL, weight: 6, opacity: 1 };
    }
    if (isRef) {
      return { ...baseStyle, color: COLOR_REF, weight: 4, opacity: 1 };
    }

    return baseStyle;
  };

  // Keep styleFnRef current so the selection-change effect always sees latest values
  styleFnRef.current = styleFn;

  // Imperatively re-style EVERY layer when the values map (or its binning)
  // changes: the Leaflet layer persists across variable / percent-toggle
  // changes, so a restyle pass replaces what used to be a full SVG rebuild.
  useEffect(() => {
    for (const layers of Object.values(layersByGeosid.current)) {
      for (const layer of layers) {
        try {
          layer.setStyle(styleFnRef.current(layer.feature));
        } catch (_) {
          // layer may have been removed during GeoJSON remount
        }
      }
    }
  }, [values, decileTransBreaks, decilePalette]);

  // Imperatively re-style layers when focal or ref selection changes
  useEffect(() => {
    const { focal: prevFocal, ref: prevRef } = prevSelected.current;

    // Re-style all geosids that were or are now selected
    const toUpdate = new Set(
      [prevFocal, prevRef, selectedGeosid, selectedRefGeosid].filter(Boolean)
    );

    for (const gid of toUpdate) {
      const layers = layersByGeosid.current[gid] || [];
      for (const layer of layers) {
        try {
          layer.setStyle(styleFnRef.current(layer.feature));
        } catch (_) {
          // layer may have been removed during GeoJSON remount
        }
      }
    }

    // Bring selected layers to front so their borders render above all others.
    // Ref first, focal second — focal ends up on top when they overlap.
    for (const gid of [selectedRefGeosid, selectedGeosid].filter(Boolean)) {
      const layers = layersByGeosid.current[gid] || [];
      for (const layer of layers) {
        try { layer.bringToFront(); } catch (_) {}
      }
    }

    prevSelected.current = { focal: selectedGeosid ?? null, ref: selectedRefGeosid ?? null };
    // mapKey dependency: the GeoJSON layer remounts on level/year change and
    // rebuilds every feature in insertion order, burying the selected
    // features' thick outlines under later-added neighbours. Re-running this
    // effect after each remount re-asserts the z-order (child layer effects
    // run before this parent effect, so the new layers are registered).
  }, [selectedGeosid, selectedRefGeosid, mapKey]);

  // --- Popup handler ---------------------------------------------------------

  const onEachFeature = (feature, layer) => {
    const props = feature.properties || {};
    const geosid = props.geosid ?? "N/A";

    // Register layer so we can imperatively update its style later
    if (geosid && geosid !== "N/A") {
      if (!layersByGeosid.current[geosid]) {
        layersByGeosid.current[geosid] = [];
      }
      layersByGeosid.current[geosid].push(layer);
    }

    const geoname = props.geoname ?? props.geosid ?? "N/A";
    const prname = props.prname ?? "";
    // Disputed territory and unenumerated residuals keep the hover tooltip
    // (their geoname says what they are) but take no click.
    const symbolisedOnly = isDisputedFeature(feature) || isPlaceholderFeature(feature);

    // Handlers are bound once at layer mount but the layer now outlives
    // variable changes, so tooltip content is computed AT HOVER TIME from
    // hoverCtxRef (current values map + labels), never baked in.
    layer.on({
      mouseover: (e) => {
        const ctx = hoverCtxRef.current;
        const rawValue = ctx.values ? ctx.values.get(String(geosid)) : null;
        const isMissingValue = rawValue == null || !Number.isFinite(Number(rawValue));
        e.target.setStyle({
          weight: 2,
          color: "#000",
          fillOpacity: isMissingValue ? 1 : hoverAlpha,
        });
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          const map = mapRef.current;
          if (!map) return;

          let valueStr;
          if (isMissingValue) {
            valueStr = "N/A";
          } else if (ctx.valueMode === "percent") {
            valueStr = `${Number(rawValue).toFixed(1)}%`;
          } else {
            const v = Number(rawValue);
            valueStr = Math.abs(v) >= 1000 ? v.toLocaleString() : v.toString();
          }
          const themeLine = ctx.themeLabel || ctx.theme || "";
          const categoryLine = ctx.codeLabel || ctx.code || "";

          // Anchor the tooltip at the centre of the polygon's VISIBLE part:
          // the bounds centre of a large unit (a territory, a northern
          // residual) is often off screen, which put the tooltip off screen
          // too. Intersect the polygon's pixel bounds with the container and
          // take that rectangle's centre; fall back to the pointer.
          let pt;
          if (e.target.getBounds) {
            const b = e.target.getBounds();
            const sw = map.latLngToContainerPoint(b.getSouthWest());
            const ne = map.latLngToContainerPoint(b.getNorthEast());
            const size = map.getSize();
            const x0 = Math.max(Math.min(sw.x, ne.x), 0), x1 = Math.min(Math.max(sw.x, ne.x), size.x);
            const y0 = Math.max(Math.min(sw.y, ne.y), 0), y1 = Math.min(Math.max(sw.y, ne.y), size.y);
            pt = (x0 < x1 && y0 < y1) ? L.point((x0 + x1) / 2, (y0 + y1) / 2) : map.latLngToContainerPoint(e.latlng);
          } else {
            pt = map.latLngToContainerPoint(e.latlng);
          }
          // No Leaflet bindPopup — tooltip is rendered as a React div so that
          // pointer-events: none prevents the tooltip DOM from triggering
          // mouseout on the polygon (which would cause an open/close cycle).
          // Tooltip state is structured data (not raw HTML) to avoid XSS risk.
          // At the tract level the context name is the metro area, which the
          // TopoJSON properties cannot carry (they hold prname only) and so
          // arrives separately. Read at hover time like everything else here,
          // since it lands after the layers are bound.
          const contextName = ctx.ctCmaNames?.[String(geosid)] ?? prname;
          setHoverTooltip({ geoname, prname: contextName, themeLine, categoryLine, valueStr, x: pt.x, y: pt.y });
        }, HOVER_POPUP_DELAY_MS);
      },
      mouseout: (e) => {
        e.target.setStyle(styleFnRef.current(feature));
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
        // Safe to close immediately — the tooltip div has pointer-events: none
        // so it never triggers this mouseout itself.
        setHoverTooltip(null);
      },
    });

    if (geosid !== "N/A" && !symbolisedOnly) {
      // Plain click selects the focal geography; Shift+click selects (or,
      // on the current comparison, clears) the reference geography.  Shift
      // is the one modifier no OS or browser intercepts on any platform.
      // Callbacks are read through hoverCtxRef at event time — the handler
      // is bound once at layer mount, and the mount-time props close over
      // stale App state.
      layer.on("click", (e) => {
        const ctx = hoverCtxRef.current;
        if (e.originalEvent?.shiftKey) {
          if (ctx.onSelectRefGeosid) ctx.onSelectRefGeosid(geosid, geoname);
        } else if (ctx.onSelectGeosid) {
          ctx.onSelectGeosid(geosid, geoname);
        }
      });
    }
  };

  const defaultCenter = [57, -96];
  const defaultZoom = 4;
  const defMinZoom = 4;

  if (import.meta.env.DEV) console.log(
    "[ChoroplethMap] render:",
    "level=", level, "year=", year, "theme=", theme, "code=", code,
    "mode=", valueMode, "log=", useLogScale, "values=", values?.size ?? 0,
    "features=", featureCollection?.features?.length ?? 0
  );

  const formatVal = (x) => {
    if (x == null || Number.isNaN(Number(x))) return "NA";
    const v = Number(x);

    if (valueMode === "percent") {
      return `${v.toFixed(1)}%`;
    }

    if (Math.abs(v) >= 1000) {
      return v.toLocaleString();
    }
    if (Math.abs(v) >= 10) {
      return v.toFixed(0);
    }
    return v.toFixed(1);
  };

  if (import.meta.env.DEV && hasData && values) {
    const sample = featureCollection.features
      .slice(0, 3)
      .map((f) => values.get(String(f.properties?.geosid)));
    console.log("[ChoroplethMap] sample values:", sample);
  }

  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      <style>{`.leaflet-overlay-pane { mix-blend-mode: multiply; }`}</style>
      {/* SVG pattern defs — referenced by Leaflet polygon fills and the legend swatch */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          <pattern id="noDataHatch" patternUnits="userSpaceOnUse" width="8" height="8">
            <rect width="8" height="8" fill="#a8c8e8"/>
            <line x1="0" y1="8" x2="8" y2="0" stroke="white" strokeWidth="1"/>
            <line x1="-2" y1="2" x2="2" y2="-2" stroke="white" strokeWidth="1"/>
            <line x1="6" y1="10" x2="10" y2="6" stroke="white" strokeWidth="1"/>
          </pattern>
        </defs>
      </svg>
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        minZoom={defMinZoom}
        // Continuous wheel / pinch zoom: no snapping to whole zoom levels, and
        // a finer wheel step with a short debounce, so the map follows the
        // wheel or trackpad instead of jumping a level per notch. The +/−
        // buttons still step by one level.
        zoomSnap={0}
        zoomDelta={1}
        wheelPxPerZoomLevel={90}
        wheelDebounceTime={20}
        // Canvas renderer: one canvas per pane instead of ~5k SVG DOM nodes —
        // much faster mount/pan/zoom on CSD/CT layers. Requires the
        // CanvasPattern no-data fill above (SVG url() fills don't work here).
        preferCanvas={true}
        // Box zoom is Leaflet's Shift+drag gesture; disabled so a sloppy
        // Shift+click (our set-comparison gesture) can never turn into a
        // surprise rectangle zoom.  Zoom controls / scroll still work.
        boxZoom={false}
        // Top-left is the legend's now, so the zoom cluster moves opposite.
        zoomControl={false}
        // Attribution is rendered in the selector panel instead (with a
        // fallback in the map corner when that panel is collapsed).
        attributionControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <ZoomControl position="topright" />
        {!plotsOpen && (
          <IconControl icon={faChartSimple} title="Show the plots panel" position="topright" onClick={onOpenPlots} />
        )}
            {showBasemap && (
              <>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                  url={cartoTileUrl("light_nolabels")}
                  subdomains="abcd"
                  maxZoom={19}
                />
                <Pane name="labels-pane" style={{ zIndex: 450 }}>
                  <TileLayer
                    url={cartoTileUrl("light_only_labels")}
                    subdomains="abcd"
                    maxZoom={19}
                  />
                </Pane>
              </>
            )}

            {hasData && (
              <GeoJSON
                key={mapKey}
                data={featureCollection}
                style={styleFn}
                onEachFeature={onEachFeature}
              />
            )}

            <MapInit mapRef={mapRef} />
            <ViewportReporter onChange={onViewportChange} />
            <ZoomToNational center={defaultCenter} zoom={defaultZoom} />
            <MapBackground showBasemap={showBasemap} />
            <MapResizer layoutKey={layoutKey} />
            <ZoomToSelected
              geojson={featureCollection}
              selectedGeosid={selectedGeosid}
            />
            <ZoomOnRequest
              geojson={featureCollection}
              geosid={selectedGeosid}
              seq={focalZoomSeq}
            />
            <ZoomOnRequest
              geojson={featureCollection}
              geosid={selectedRefGeosid}
              seq={refZoomSeq}
              overrideGeojson={refPolygon}
            />

            {/* Selection outlines — own pane above the choropleth (400) and
                province boundaries (410), below the ref-polygon pane (445) and
                labels (450).  Rendered as separate prop-driven layers so they
                can NEVER be buried by the main layer's draw order: the old
                approach (thick strokes styled in-place + bringToFront) lost
                its z-order every time the GeoJSON remounted on level/year
                change.  mix-blend-mode normal so multiply compositing never
                dulls the highlight colours; pointerEvents none so the pane's
                canvas doesn't swallow map interaction. */}
            <Pane
              name="selection-outline-pane"
              style={{ zIndex: 430, mixBlendMode: "normal", pointerEvents: "none" }}
            >
              {/* Both casings first, then both cores: drawn casing-core,
                  casing-core, the focal's casing would paint over the
                  comparison's line wherever the two geographies touch. */}
              {selectionOutlineFC.ref && (
                <GeoJSON
                  key={`sel-ref-casing-${mapKey}-${selectedRefGeosid}`}
                  data={selectionOutlineFC.ref}
                  style={() => outlineStyle(CASING_COLOR, REF_WEIGHT + CASING_EXTRA)}
                />
              )}
              {selectionOutlineFC.focal && (
                <GeoJSON
                  key={`sel-focal-casing-${mapKey}-${selectedGeosid}`}
                  data={selectionOutlineFC.focal}
                  style={() => outlineStyle(CASING_COLOR, FOCAL_WEIGHT + CASING_EXTRA)}
                />
              )}
              {selectionOutlineFC.ref && (
                <GeoJSON
                  key={`sel-ref-${mapKey}-${selectedRefGeosid}`}
                  data={selectionOutlineFC.ref}
                  style={() => outlineStyle(COLOR_REF, REF_WEIGHT)}
                />
              )}
              {selectionOutlineFC.focal && (
                <GeoJSON
                  key={`sel-focal-${mapKey}-${selectedGeosid}`}
                  data={selectionOutlineFC.focal}
                  style={() => outlineStyle(COLOR_FOCAL, FOCAL_WEIGHT)}
                />
              )}
            </Pane>

            {/* Provincial boundary overlay — above data polygons, below labels */}
            {/* pointerEvents none: with the canvas renderer each pane's canvas
                is an opaque hit-target that would swallow mouse events meant
                for the choropleth canvas below (SVG roots were transparent) */}
            <Pane name="province-boundaries" style={{ zIndex: 410, pointerEvents: "none" }}>
              {provinceBoundaries && (
                <GeoJSON
                  // react-leaflet's GeoJSON reads `data` at mount only. The
                  // year's overlay arrives after the year changes (bundle
                  // expansion or the /api/boundaries fetch), so the key must
                  // change with the data too or the previous year's
                  // provinces stay on screen (seen: 2021 outlines over 1871).
                  key={`pb-${year}-${provinceBoundaries.features?.length ?? 0}-${provinceBoundaries.features?.[0]?.properties?.geosid ?? ""}`}
                  data={provinceBoundaries}
                  style={() => ({
                    fill: false,
                    color: COLOR_PROVINCE_BOUNDARY,
                    weight: 1.5,
                    opacity: 0.7,
                    interactive: false,
                  })}
                />
              )}
            </Pane>

            {/* Reference geography outline — sits above the province boundary layer
                (410) and just below map labels (450).  mix-blend-mode is forced to
                "normal" so the magenta colour is never composited away by the
                multiply blend applied to the main overlay pane. */}
            <Pane name="ref-polygon-pane" style={{ zIndex: 445, mixBlendMode: "normal", pointerEvents: "none" }}>
              {refPolygon && (() => {
                const fc =
                  refPolygon.type === "FeatureCollection"
                    ? refPolygon
                    : { type: "FeatureCollection", features: [refPolygon] };
                const id = refPolygon.properties?.geosid ?? "ref";
                return (
                  <>
                    <GeoJSON key={`ref-casing-${id}`} data={fc} style={() => outlineStyle(CASING_COLOR, REF_WEIGHT + CASING_EXTRA)} />
                    <GeoJSON key={`ref-${id}`} data={fc} style={() => outlineStyle(COLOR_REF, REF_WEIGHT)} />
                  </>
                );
              })()}
            </Pane>
      </MapContainer>

      {/* Hover tooltip — React div, pointer-events:none so it never triggers
          mouseout on the polygon beneath it, preventing open/close cycling. */}
      {hoverTooltip && (
        <div
          style={{
            position: "absolute",
            left: hoverTooltip.x,
            top: hoverTooltip.y,
            transform: "translate(-50%, calc(-100% - 12px))",
            zIndex: 1001,
            pointerEvents: "none",
            background: isDark ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)",
            border: `1px solid ${isDark ? "#555" : "#ccc"}`,
            borderRadius: 4,
            padding: "6px 9px",
            fontSize: "0.78rem",
            lineHeight: 1.5,
            color: isDark ? "#e8e8e8" : "#222",
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            whiteSpace: "nowrap",
          }}
        >
          <div>
            <strong>{hoverTooltip.geoname}</strong>
            {hoverTooltip.prname && `, ${hoverTooltip.prname}`}
          </div>
          {hoverTooltip.themeLine && (
            <div style={{ marginTop: 2 }}>{hoverTooltip.themeLine}</div>
          )}
          <div style={{ marginTop: 2 }}>
            {hoverTooltip.categoryLine
              ? <>{hoverTooltip.categoryLine}: <strong>{hoverTooltip.valueStr}</strong></>
              : <strong>{hoverTooltip.valueStr}</strong>
            }
          </div>
        </div>
      )}

      {!hasData && geometry !== null && level && year && theme && code && (
        // geometry was fetched (all params set) but came back empty — no polygons
        // for this level/year combination exist in the database.
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1000,
            maxWidth: 340,
            padding: "12px 18px",
            borderRadius: 6,
            background: isDark ? "rgba(30,30,30,0.92)" : "rgba(255,255,255,0.92)",
            border: `1px solid ${isDark ? "#666" : "#bbb"}`,
            color: isDark ? "#e8e8e8" : "#333",
            fontSize: "0.88rem",
            lineHeight: 1.5,
            textAlign: "center",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            pointerEvents: "none",
          }}
        >
          No map is available for this census year.
        </div>
      )}
      {!hasData && geometry === null && (
        <p style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", color: "#555", background: "rgba(255,255,255,0.85)", padding: "4px 10px", borderRadius: 4, fontSize: 13 }}>
          No map data. Choose a place, theme, year, and category.
        </p>
      )}

      {showAttribution && (
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            zIndex: 1000,
            padding: "0 5px",
            fontSize: "11px",
            lineHeight: "1.4",
            color: isDark ? "#c8c8c8" : "#333",
            background: isDark ? "rgba(30,30,30,0.85)" : "rgba(255,255,255,0.85)",
          }}
        >
          Leaflet | &copy;{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>OpenStreetMap</a>
          {" "}contributors &copy;{" "}
          <a href="https://carto.com/attributions" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>CARTO</a>
        </div>
      )}

      {/* Legend — top-left, horizontal. Opaque: text on a 92%-white panel over
          a choropleth has no stable contrast ratio, so it was the one style the
          audit could not put a number on.

          The ramp replaces eleven stacked swatch rows with one bar, taking the
          legend from 175x272 to 344x102 (measured) and giving 170px of map
          height back. Five labels instead of ten class ranges: each sits on the RIGHT
          edge of its cell, so it names the boundary it points at rather than
          floating between two classes. Reading an exact interior break is the
          thing this trades away. */}
      <DataLoadingIndicator />

      {/* Top-left stack: the legend, then the selector-panel button beneath it.
          A flex column rather than a hand-computed offset, so the button
          follows the legend's height and sits at the top when there is no
          legend to sit under. */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 10,
          pointerEvents: "none",
        }}
      >
      {hasData && decileRawBreaks && decilePalette && (
        <div
          ref={legendRef}
          style={{
            pointerEvents: "auto",
            width: 344,
            padding: "9px 12px 8px",
            border: `1px solid ${isDark ? "#555" : "#ddd"}`,
            borderRadius: 6,
            background: isDark ? "#1e1e1e" : "#ffffff",
            color: isDark ? "#e8e8e8" : "#222",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, lineHeight: 1.3 }}>
            {codeLabel || themeLabel || "Legend"}{year ? ` · ${year}` : ""}
          </div>

          <div
            style={{
              display: "flex",
              height: 14,
              borderRadius: 3,
              overflow: "hidden",
              border: `1px solid ${isDark ? "#777" : "#999"}`,
            }}
          >
            {decilePalette.map((color, i) => (
              <div key={i} style={{ flex: 1, background: color }} />
            ))}
          </div>

          {/* Five equal cells over ten equal classes: each label right-aligns on
              the boundary after classes 2, 4, 6, 8 and 10. */}
          <div style={{ display: "flex", fontSize: 12, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {[1, 3, 5, 7].map((b) => (
              <div key={b} style={{ flex: 1, textAlign: "right" }}>{formatVal(decileRawBreaks[b])}</div>
            ))}
            <div style={{ flex: 1, textAlign: "right" }}>{formatVal(decileRawBreaks[8])}+</div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <svg width="14" height="14" style={{ flexShrink: 0, display: "block", borderRadius: 2, border: `1px solid ${isDark ? "#777" : "#999"}` }}>
              <rect width="14" height="14" fill="url(#noDataHatch)" />
            </svg>
            <span style={{ fontSize: 12 }}>No data · 10 equal-count classes</span>
          </div>
        </div>
      )}

      {/* leaflet-bar so it matches the zoom cluster's border, radius and shadow
          exactly rather than restating them. */}
      {!selectorsOpen && (
        <div className="leaflet-bar" style={{ margin: 0, pointerEvents: "auto" }}>
          <a
            href="#"
            role="button"
            title="Show the selector panel"
            onClick={(e) => { e.preventDefault(); onOpenSelectors?.(); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, cursor: "pointer" }}
            ref={(el) => {
              if (!el || el.querySelector("svg")) return;
              el.appendChild(faSvg(faFilter));
            }}
          />
        </div>
      )}
      </div>
    </div>
  );
});

export default ChoroplethMap;
