// src/bivariate.js
//
// The pure half of the bivariate map (docs/BIVARIATE-MAP.md): class breaks,
// the colour grid, the cross-tabulation and the rank correlation. No React
// or map code, so test/bivariate.test.js can run it under plain Node.

// Corners low-low, x high, y high, both high, blended bilinearly. Chosen by
// search so every pair of the 3x3 stays at CIE76 dE >= 21 under normal vision,
// protanopia, deuteranopia and tritanopia (method:
// docs/COLOUR-ACCESSIBILITY-AUDIT.md).
const CORNERS = [[0xf4, 0xf4, 0xf4], [0x0f, 0x8a, 0x7f], [0xaa, 0x00, 0xcc], [0x11, 0x11, 0x22]];

// gridColors(n)[i + n * j]: i = first variable's class, j = second's, 0 = low.
export function gridColors(n) {
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), w = j / (n - 1);
      const rgb = [0, 1, 2].map((k) => Math.round(
        CORNERS[0][k] * (1 - u) * (1 - w) + CORNERS[1][k] * u * (1 - w) + CORNERS[2][k] * (1 - u) * w + CORNERS[3][k] * u * w,
      ));
      out.push(`#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    }
  }
  return out;
}

export const classNames = (n) => (n === 4 ? ["low", "mid-low", "mid-high", "high"] : ["low", "mid", "high"]);

// Below this share of units above the minimum there is nothing to compare.
const MIN_ABOVE_SHARE = 0.05;

const finite = (v) => v != null && Number.isFinite(Number(v));

// Upper bounds of the k/n quantiles of a sorted array, k = 1 .. n - 1.
const quantileCuts = (a, n) => Array.from({ length: n - 1 }, (_, k) => a[Math.ceil((a.length * (k + 1)) / n) - 1]);

// Breaks for one variable into n classes, as the upper bound of each class but
// the last.
//   kind "equal": equal-count classes (thirds, quartiles), the normal case.
//   kind "floor": at least 1/n of units share the minimum (usually 0), so the
//                 cuts would collapse: the lowest class is the minimum and the
//                 units above it split into equal counts.
//   kind "fewer": ties leave fewer classes; they spread over the grid's rows.
//   kind "none":  not mappable; `reason` says why ("constant" | "rare" | "empty").
export function classBreaks(values, n = 3) {
  const a = values.filter(finite).map(Number).sort((x, y) => x - y);
  if (!a.length) return { kind: "none", reason: "empty", upper: [], n };
  const min = a[0], max = a[a.length - 1];
  if (min === max) return { kind: "none", reason: "constant", upper: [], n, min, max };

  const atMin = a.findIndex((v) => v > min);   // how many units share the minimum
  const floor = atMin / a.length >= 1 / n;
  const above = a.slice(atMin);
  if (floor && above.length / a.length < MIN_ABOVE_SHARE) return { kind: "none", reason: "rare", upper: [], n, min, max };

  // A cut at the maximum would leave the top class empty; move it down a value.
  const belowMax = a.filter((v) => v < max).at(-1);
  const raw = floor ? [min, ...quantileCuts(above, n - 1)] : quantileCuts(a, n);
  const upper = [...new Set(raw.map((c) => (c === max ? belowMax : c)))];
  const kind = upper.length === 1 ? "fewer" : floor ? "floor" : upper.length === n - 1 ? "equal" : "fewer";
  return { kind, upper, n, min, max, ...(floor ? { floorShare: atMin / a.length } : {}) };
}

// The grid row or column, 0 .. n - 1. Fewer classes spread over the grid, so
// two classes take its low and high ends.
export const rowOf = (k, breaks) => Math.round((k * (breaks.n - 1)) / breaks.upper.length);

export function classify(v, breaks) {
  if (!finite(v) || !breaks.upper.length) return null;
  const x = Number(v);
  const k = breaks.upper.findIndex((u) => x <= u);
  return rowOf(k < 0 ? breaks.upper.length : k, breaks);
}

// Average ranks, so ties (all those zeros) do not invent an order.
function ranks(v) {
  const order = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(v.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const m = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - m) * (ry[i] - m);
    sxx += (rx[i] - m) ** 2;
    syy += (ry[i] - m) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Least-squares line and Pearson's r: { slope, intercept, r }, or null when x
// doesn't vary. r is null when y doesn't vary.
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: syy ? sxy / Math.sqrt(sxx * syy) : null };
}

// The part of a fitted line inside a plot's ranges: [[x1, y1], [x2, y2]], or null
// when the line misses them.
export function clipFit(fit, xMin, xMax, yMin, yMax) {
  const { slope, intercept } = fit;
  let x1 = xMin, x2 = xMax;
  if (slope) {
    const a = (yMin - intercept) / slope, b = (yMax - intercept) / slope;
    x1 = Math.max(x1, Math.min(a, b));
    x2 = Math.min(x2, Math.max(a, b));
  } else if (intercept < yMin || intercept > yMax) return null;
  if (x1 >= x2) return null;
  return [[x1, slope * x1 + intercept], [x2, slope * x2 + intercept]];
}

// Log axes. Zero can't be logged, so places at or below zero on either variable
// are left out of a log plot and its statistics.
export const canLog = (p) => p.x > 0 && p.y > 0;

// Where a log axis stops: its smallest positive value, or null if there is none.
export function logFloor(values) {
  let floor = null;
  for (const v of values) if (v > 0 && (floor == null || v < floor)) floor = v;
  return floor;
}

// The least-squares line and Pearson's r on logged values, over the given
// places: { slope, intercept, r }, or null.
export function logFit(points) {
  return linearFit(points.map((p) => Math.log10(p.x)), points.map((p) => Math.log10(p.y)));
}

// Round tick values for a log axis from min to max (both positive): spaced so
// their labels fit a plot about 200px across, whatever decades the axis spans.
export function logTicks(min, max) {
  const span = Math.log10(max / min);
  const steps = span <= 1 ? [1, 1.5, 2, 3, 5, 7] : span <= 1.5 ? [1, 2, 5] : span <= 2.5 ? [1, 3] : [1];
  const every = span > 4 ? 2 : 1;
  const first = Math.floor(Math.log10(min));
  const out = [];
  for (let k = first; k <= Math.ceil(Math.log10(max)); k += every) {
    for (const s of steps) {
      const v = Number((s * 10 ** k).toPrecision(3));
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

// Both Maps are geosid -> display value. Breaks are taken over units that have
// BOTH values, so the classes describe what the map shows.
//   { usable: false, unusable: "first" | "second" | "both", reason }
//   { usable: true, size, colors, breaksX, breaksY, cells: Map(geosid -> { i, j }),
//     points: [{ geosid, x, y, i, j }], counts[i + size * j], n, rho, fit }
export function buildBivariate(valuesX, valuesY, size = 3) {
  const points = [];
  for (const [geosid, x] of valuesX) {
    const y = valuesY.get(geosid);
    if (finite(x) && finite(y)) points.push({ geosid, x: Number(x), y: Number(y) });
  }
  const breaksX = classBreaks(points.map((p) => p.x), size);
  const breaksY = classBreaks(points.map((p) => p.y), size);
  if (breaksX.kind === "none" || breaksY.kind === "none") {
    const unusable = breaksX.kind === "none" && breaksY.kind === "none" ? "both" : breaksX.kind === "none" ? "first" : "second";
    return { usable: false, unusable, reason: (breaksX.kind === "none" ? breaksX : breaksY).reason };
  }
  const counts = new Array(size * size).fill(0);
  const cells = new Map();
  for (const p of points) {
    p.i = classify(p.x, breaksX);
    p.j = classify(p.y, breaksY);
    counts[p.i + size * p.j]++;
    cells.set(p.geosid, { i: p.i, j: p.j });
  }
  return {
    usable: true, size, colors: gridColors(size), breaksX, breaksY, cells, points, counts, n: points.length,
    rho: spearman(points.map((p) => p.x), points.map((p) => p.y)),
    fit: linearFit(points.map((p) => p.x), points.map((p) => p.y)),
  };
}
