// Selection colours — used on the map borders, plot lines/bars, and indicator dots.
// Focal green must keep >=3:1 contrast on the white basemap (WCAG 1.4.11).
export const COLOR_FOCAL = "#00a63c";
export const COLOR_REF   = "#ff00ff";

// The maple-leaf red, shared by the zoom-to-national control and the wordmark.
// #c8102e measures 5.88:1 on white but only 2.93:1 on the dark header, so dark
// mode takes a lightened tone of the same hue (4.02:1).
export const COLOR_BRAND = "#c8102e";
export const COLOR_BRAND_DARK = "#e03a52";

// Provincial boundary overlay colour.
export const COLOR_PROVINCE_BOUNDARY = "#777777";

// Delay (ms) before a hover popup appears on a map polygon.
export const HOVER_POPUP_DELAY_MS = 25;

// Global app metadata — edit these values when releasing updates.
export const APP_VERSION = "0.9.1";
export const APP_LAST_UPDATED = "2026-09-11";
// Update DATA_LAST_UPDATED whenever the census data is refreshed.
export const DATA_LAST_UPDATED = "2026-09-12";

// Selection colours come in two tones.
//
// The MAP tone sits on the choropleth, where brightness is what separates the
// outline from the inferno ramp; it only has to clear 3:1 as a graphic
// (WCAG 1.4.11).  The INK tone is for text, chart lines and legend swatches on
// a light panel, where small text has to clear 4.5:1 (WCAG 1.4.3).  Measured
// against #ffffff, COLOR_FOCAL is 3.22:1 and COLOR_REF is 3.14:1 — fine on the
// map, well short for 11px labels, which is why these exist.
export const COLOR_FOCAL_INK = "#0b7a35";  // 5.46:1 on white
export const COLOR_REF_INK   = "#a10ca1";  // 6.81:1 on white

// Mantine's default dimmed grey (#868e96) is 3.32:1 — below the 4.5:1 body-text
// threshold.  TEXT_DIM replaces it via the theme in main.jsx.
export const TEXT_DIM = "#5c636a";         // 6.09:1 on white

// Mantine's default input border (#ced4da) is 1.49:1, below the 3:1 required of
// a control boundary.  #868e96 clears it and is already in the palette.
export const BORDER_CONTROL = "#868e96";   // 3.32:1 on white

// Which tone to use depends on what the mark sits on.
//
// Measured against the light panel (#ffffff) and the dark panel (#1a1b1e):
//                    on white   on dark
//   COLOR_FOCAL       3.22       5.35
//   COLOR_FOCAL_INK   5.46       3.16
//   COLOR_REF         3.14       5.49
//   COLOR_REF_INK     6.81       2.53
//
// So the ink tones are a LIGHT-MODE substitution only — in dark mode the
// original bright tones are already the accessible choice, and the ink tones
// would fail. Plots and any other text on a themed panel should call this
// rather than importing a tone directly. Map outlines always use the bright
// tone, because they sit on the choropleth rather than on a panel.
export function seriesColors(colorScheme) {
  return colorScheme === "dark"
    ? { focal: COLOR_FOCAL, ref: COLOR_REF }
    : { focal: COLOR_FOCAL_INK, ref: COLOR_REF_INK };
}

// Display form of a geography label.
//
// Census tracts are already identified by "FSA | tract number", and the rest of
// the label repeats that number as the geosid:
//   "N6C | 5550004.01 - CT (1986-2021) (5550004.01)" -> "N6C | 5550004.01"
//
// Everything else keeps its type and year span and loses only the geosid, which
// the selectors append so it can be searched on:
//   "Ottawa (C) - CSD (2001-2021) (3506008)" -> "Ottawa (C) - CSD (2001-2021)"
export function geoDisplayName(label) {
  if (typeof label !== "string") return label;
  const ct = label.match(/^(.*?)\s+-\s+CT\b/);
  if (ct) return ct[1].trim();
  // Strip the appended geosid, "(3520)". Search labels carry a year span in
  // their own parenthetical — "(1976-2021)" or a single census "(1861)" —
  // so the id is only the trailing parenthetical when it FOLLOWS another
  // one; a lone trailing "(1861)" is the span and must stay.
  const withSpan = label.replace(/(\))\s*\([\d.]{2,}\)\s*$/, "$1");
  if (withSpan !== label) return withSpan;
  if (/\)\s*$/.test(label) && (label.match(/\(/g) || []).length === 1 && /\(\d{4}\)\s*$/.test(label) && /\s-\s(CSD|CD|CMA|PR)\s\(\d{4}\)\s*$/.test(label)) return label;
  return label.replace(/\s*\([\d.]{2,}\)\s*$/, "");
}

// Label for a geography option in the selectors: the display name only. The
// geosid is deliberately not shown (project lead, 2026-09-06): it is an
// internal key, and before 1981 the same code names a different place in each
// census, so it would only mislead. The search still matches typed ids
// server-side, and the selected value is carried by the option index.
export function geoOptionLabel(label, geosid) {   // eslint-disable-line no-unused-vars
  return geoDisplayName(label) ?? "";
}

// ── CARTO basemap ────────────────────────────────────────────────────────────
//
// CARTO began requiring an API key on its raster basemaps in 2026. An unkeyed
// request still returns HTTP 200 with a valid PNG — the refusal is painted into
// the image as "API KEY REQUIRED" across every tile — so a broken basemap is
// invisible to status-code checks and only shows up on screen. Keys are free
// within CARTO's fair-use limit of 5M tile requests/month:
// https://carto.com/basemaps/apikey/
//
// This is a client-side credential by nature: the browser makes every tile
// request, so the key is visible in the built bundle and in the network panel
// wherever it is stored. Restrict it by domain in the CARTO dashboard rather
// than treating it as a secret. Set it in frontend/.env (gitignored) as
// VITE_CARTO_KEY — see frontend/.env.example.
//
// Note for later: CARTO is phasing out raster basemaps and has said it may stop
// updating their data, so the cartography will drift. The recommended migration
// is to vector basemaps, which the same key covers.
export const CARTO_KEY = import.meta.env.VITE_CARTO_KEY ?? "";

// Leaflet tile URL for a CARTO raster style, with the key appended when one is
// configured. The {s}/{z}/{x}/{y}/{r} placeholders are Leaflet's, substituted
// per tile; subdomains remain supported alongside the key.
export function cartoTileUrl(style) {
  const base = `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
  return CARTO_KEY ? `${base}?key=${encodeURIComponent(CARTO_KEY)}` : base;
}
