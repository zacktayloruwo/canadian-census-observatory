// src/BivariatePlot.jsx
//
// The relationship between the bivariate map's two variables, and the map's key
// while the plots rail is open: a square plot with one dot per unit over the
// map's colour bands, white lines at the class cuts above the dots, a red
// least-squares line, and the
// cuts' percentiles marked along the plot's top and right sides.
// Hovering a band highlights its units on the map. Spearman's rank correlation
// fits skewed shares and matches the classes; there is no p-value, since this
// is close to a full count of areas.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Switch, Text, useMantineColorScheme } from "@mantine/core";
import echarts from "./echartsCore";
import { canLog, classify, classNames, clipFit, logFit, logFloor, logTicks, rowOf, spearman } from "./bivariate";
import { seriesColors } from "./config";

// Margins: left + right = top + bottom keeps the plotting area square in a
// square chart. The left and bottom hold the tick labels and axis name, the top
// and right the percentile marks.
const GRID = { left: 54, right: 38, top: 38, bottom: 54 };
const MARK_LEAD = 10;       // px from the plot's edge out to the marks
const MARK_FONT = 12;
const MARK_GAP_X = 30;      // px between mark centres along each axis
const MARK_GAP_Y = 14;

// A percentage axis stops at 100%, whatever the data holds; a dot past that sits
// on the edge and its tooltip gives the true value.
const PCT_CAP = 100;
const capValue = (v, pct) => (pct ? Math.min(v, PCT_CAP) : v);
const capBreaks = (b, pct) => ({ ...b, max: capValue(b.max, pct), upper: b.upper.map((u) => capValue(u, pct)) });

// Class edges along one axis: [{ from, to, cls }].
function bands(b) {
  const edges = [b.min, ...b.upper, b.max];
  return edges.slice(1).map((to, k) => ({ from: edges[k], to, cls: rowOf(k, b) }));
}

// See-through dots: a thin yellow-orange ring with no fill, which shows on every
// band and leaves the band's colour visible through it.
const DOT = { color: "rgba(255,159,0,0)", borderColor: "rgba(255,159,0,0.6)", borderWidth: 0.5 };

const fmt = (v, pct) => (pct ? `${Number(v).toFixed(1)}%` : Number(v).toLocaleString());

function ordinal(n) {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

// The percentile each cut stands at. Equal classes read as their nominal
// quartile unless ties have moved a cut well off it; a floor class reads as
// where its cut actually falls.
function cutPercentiles(b, values) {
  const sorted = values.length;
  return b.upper.map((cut, k) => {
    const actual = Math.round((100 * values.filter((v) => v <= cut).length) / sorted);
    const nominal = Math.round((100 * (k + 1)) / b.n);
    return b.kind === "equal" && Math.abs(actual - nominal) <= 5 ? nominal : actual;
  });
}

// Spread positions so neighbours keep `gap`, staying as near their marks as
// they can inside [lo, hi].
function spread(positions, gap, lo, hi) {
  const order = positions.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = order.map(([p]) => p);
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  const over = out[out.length - 1] - hi;
  if (over > 0) out[out.length - 1] = hi;
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  if (out[0] < lo) {
    out[0] = lo;
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  }
  const result = [];
  order.forEach(([, i], k) => { result[i] = out[k]; });
  return result;
}

export default function BivariatePlot({ bivariate, geometry, xLabel, yLabel, xPercent, yPercent, focalGeosid, refGeosid, highlightCell, onHighlightCell, note }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const marksRef = useRef(() => {});
  const [logAxes, setLogAxes] = useState(false);
  const hoverRef = useRef(() => {});
  const { colorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";
  const { points, breaksX, breaksY, rho, fit, n, size, colors, counts } = bivariate;
  const names = classNames(size);
  const unequal = breaksX.kind !== "equal" || breaksY.kind !== "equal";
  const cellCount = highlightCell ? counts[highlightCell.i + size * highlightCell.j] : 0;

  const placeNames = useMemo(() => {
    const m = new Map();
    for (const f of geometry?.features ?? []) m.set(String(f.properties?.geosid), f.properties?.geoname);
    return m;
  }, [geometry]);
  const pctX = useMemo(() => cutPercentiles(breaksX, points.map((p) => p.x)), [breaksX, points]);
  const pctY = useMemo(() => cutPercentiles(breaksY, points.map((p) => p.y)), [breaksY, points]);
  const axisX = useMemo(() => capBreaks(breaksX, xPercent), [breaksX, xPercent]);
  const axisY = useMemo(() => capBreaks(breaksY, yPercent), [breaksY, yPercent]);
  // Log axes redraw the plot only: the classes are percentiles, so the map and
  // Spearman's r don't change. Everything is plotted in logged units.
  const floorX = useMemo(() => logFloor(points.map((p) => p.x)), [points]);
  const floorY = useMemo(() => logFloor(points.map((p) => p.y)), [points]);
  const logOk = floorX != null && floorY != null;
  const logOn = logAxes && logOk;
  // With log axes the plot and both correlations cover only the places that can
  // be logged, so the numbers describe the dots on show.
  const shownPoints = useMemo(() => (logOn ? points.filter(canLog) : points), [logOn, points]);
  const shownFit = useMemo(() => (logOn ? logFit(shownPoints) : fit), [logOn, shownPoints, fit]);
  const shownRho = useMemo(
    () => (logOn ? spearman(shownPoints.map((p) => p.x), shownPoints.map((p) => p.y)) : rho),
    [logOn, shownPoints, rho],
  );
  const removed = points.length - shownPoints.length;

  useEffect(() => {
    const chart = echarts.init(elRef.current, isDark ? "dark" : null);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => { chart.resize(); marksRef.current(); });
    ro.observe(elRef.current);
    const zr = chart.getZr();
    const onMove = (e) => hoverRef.current(e.offsetX, e.offsetY);
    const onOut = () => hoverRef.current(null);
    zr.on("mousemove", onMove);
    zr.on("globalout", onOut);
    return () => { ro.disconnect(); chart.dispose(); chartRef.current = null; };
  }, [isDark]);

  // Hover: the band under the pointer, reported only when it changes.
  const lastCell = useRef(null);
  useEffect(() => {
    hoverRef.current = (x, y) => {
      const chart = chartRef.current;
      let cell = null;
      if (chart && x != null && chart.containPixel("grid", [x, y])) {
        const [vx, vy] = chart.convertFromPixel("grid", [x, y]);
        const i = classify(logOn ? 10 ** vx : vx, breaksX), j = classify(logOn ? 10 ** vy : vy, breaksY);
        if (i != null && j != null) cell = { i, j };
      }
      if (cell?.i === lastCell.current?.i && cell?.j === lastCell.current?.j) return;
      lastCell.current = cell;
      onHighlightCell?.(cell);
    };
  }, [breaksX, breaksY, logOn, onHighlightCell]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const seriesColours = seriesColors(colorScheme);
    const tx = (v) => (logOn ? Math.log10(Math.max(v, floorX)) : v);
    const ty = (v) => (logOn ? Math.log10(Math.max(v, floorY)) : v);
    const inCell = (p) => p.i === highlightCell?.i && p.j === highlightCell?.j;
    const fitLine = shownFit && clipFit(shownFit, tx(axisX.min), tx(axisX.max), ty(axisY.min), ty(axisY.max));
    const row = (p) => [tx(capValue(p.x, xPercent)), ty(capValue(p.y, yPercent)), p.geosid, p.x, p.y];
    const area = [];
    for (const bx of bands(axisX)) for (const by of bands(axisY)) {
      area.push([
        { xAxis: tx(bx.from), yAxis: ty(by.from), itemStyle: { color: colors[bx.cls + size * by.cls] } },
        { xAxis: tx(bx.to), yAxis: ty(by.to) },
      ]);
    }
    const marked = (geosid, color) => {
      const p = shownPoints.find((q) => q.geosid === String(geosid));
      return p ? [{ value: row(p), itemStyle: { color: "rgba(255,255,255,0)", borderColor: color, borderWidth: 3 } }] : [];
    };
    const tick = (v, pct) => (pct ? `${Number(v.toFixed(1))}%` : v >= 1000 ? `${Math.round(v / 1000)}k` : v);
    const logTick = (v, pct) => {
      const raw = Number((10 ** v).toPrecision(3));
      return pct ? `${raw}%` : raw >= 1000 ? `${Math.round(raw / 1000)}k` : raw;
    };
    const axis = (name, pct, b, nameGap, t, floor) => ({
      type: "value", name, nameLocation: "middle", min: t(b.min), max: t(b.max), nameGap,
      nameTextStyle: { fontWeight: 700, overflow: "truncate", width: 190 },
      splitLine: { show: false },
      axisLabel: logOn
        ? { margin: 5, customValues: logTicks(Math.max(b.min, floor), b.max).map(Math.log10), formatter: (v) => logTick(v, pct) }
        : { hideOverlap: true, margin: 5, formatter: (v) => tick(v, pct) },
      axisTick: logOn ? { customValues: logTicks(Math.max(b.min, floor), b.max).map(Math.log10) } : {},
    });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: GRID,
      tooltip: {
        trigger: "item", confine: true,
        formatter: (o) => `<strong>${placeNames.get(o.value[2]) ?? o.value[2]}</strong><br/>${xLabel}: ${fmt(o.value[3], xPercent)}<br/>${yLabel}: ${fmt(o.value[4], yPercent)}`,
      },
      xAxis: axis(xLabel, xPercent, axisX, 24, tx, floorX),
      yAxis: axis(yLabel, yPercent, axisY, 44, ty, floorY),
      series: [
        {
          type: "scatter", symbolSize: 2.5, large: false, z: 2,
          data: shownPoints.filter((p) => !highlightCell || !inCell(p)).map(row),
          itemStyle: { ...DOT, opacity: highlightCell ? 0.2 : 1 },
          markArea: { silent: true, itemStyle: { opacity: 1 }, data: area },
        },
        { type: "scatter", symbolSize: 4, z: 3, data: highlightCell ? shownPoints.filter(inCell).map(row) : [], itemStyle: { color: "rgba(255,255,255,0)", borderColor: "#ffb000", borderWidth: 1 } },
        // The cuts, above the dots.
        {
          type: "scatter", symbolSize: 0, z: 10, silent: true, data: [[tx(axisX.min), ty(axisY.min)]],
          markLine: {
            silent: true, z: 10, symbol: "none", animation: false, label: { show: false },
            lineStyle: { color: "#ffffff", width: 0.75, type: "solid", opacity: 1 },
            data: [...axisX.upper.map((c) => ({ xAxis: tx(c) })), ...axisY.upper.map((c) => ({ yAxis: ty(c) }))],
          },
        },
        // The least-squares line, on the true values.
        {
          type: "scatter", symbolSize: 0, z: 11, silent: true, data: [[tx(axisX.min), ty(axisY.min)]],
          markLine: {
            silent: true, z: 11, symbol: "none", animation: false, label: { show: false },
            lineStyle: { color: "#e3000b", width: 1.5, type: "solid", opacity: 1 },
            data: fitLine ? [[{ coord: fitLine[0] }, { coord: fitLine[1] }]] : [],
          },
        },
        { type: "scatter", symbolSize: 10, z: 12, data: [...marked(refGeosid, seriesColours.ref), ...marked(focalGeosid, seriesColours.focal)] },
      ],
    }, true);

    // The percentile marks sit outside the plot, in pixels, so they are
    // redrawn with the chart. Where cuts crowd together the marks spread out
    // and a thin leader line ties each one to its cut.
    marksRef.current = () => {
      const c = chartRef.current;
      if (!c || !elRef.current) return;
      const w = c.getWidth(), h = c.getHeight();
      const bottomY = h - GRID.bottom, edgeX = w - GRID.right;
      const text = isDark ? "#e8e8e8" : "#222";
      const lead = isDark ? "#888" : "#999";
      const px = axisX.upper.map((v) => c.convertToPixel({ xAxisIndex: 0 }, tx(v)));
      const py = axisY.upper.map((v) => c.convertToPixel({ yAxisIndex: 0 }, ty(v)));
      const sx = spread(px, MARK_GAP_X, GRID.left + 8, w - GRID.right - 8);
      const sy = spread(py, MARK_GAP_Y, GRID.top + 5, bottomY - 5);
      const style = { fontSize: MARK_FONT, fontWeight: 700, fill: text };
      const line = (x1, y1, x2, y2) => ({ type: "line", silent: true, shape: { x1, y1, x2, y2 }, style: { stroke: lead, lineWidth: 1 } });
      const graphic = [];
      px.forEach((p, k) => {
        const y = GRID.top - MARK_LEAD;
        graphic.push(line(p, GRID.top - 1, sx[k], y));
        graphic.push({ type: "text", silent: true, x: sx[k], y: y - 1, style: { ...style, text: ordinal(pctX[k]), align: "center", verticalAlign: "bottom" } });
      });
      py.forEach((p, k) => {
        const x = edgeX + MARK_LEAD;
        graphic.push(line(edgeX + 1, p, x, sy[k]));
        graphic.push({ type: "text", silent: true, x: x + 2, y: sy[k], style: { ...style, text: ordinal(pctY[k]), align: "left", verticalAlign: "middle" } });
      });
      c.setOption({ graphic: { elements: graphic.map((g, i) => ({ id: `mark${i}`, ...g })) } }, { replaceMerge: ["graphic"] });
    };
    marksRef.current();
  }, [shownPoints, axisX, axisY, logOn, floorX, floorY, shownFit, size, colors, highlightCell, focalGeosid, refGeosid, placeNames, xLabel, yLabel, xPercent, yPercent, colorScheme, isDark, pctX, pctY]);

  const coef = (r) => (r == null ? "n/a" : r.toFixed(2));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <Text size="sm" fw={600}>Bivariate relationship</Text>
        <Switch size="xs" label="Log axes" checked={logOn} disabled={!logOk} onChange={(e) => setLogAxes(e.currentTarget.checked)} styles={{ label: { fontSize: 12, paddingLeft: 6 } }} />
      </div>
      {/* The negative margin takes up the blank strip the square leaves under the x-axis title. */}
      <div ref={elRef} style={{ width: "100%", aspectRatio: "1 / 1", marginBottom: -12 }} />
      {/* Two lines' height either way, so hovering doesn't move the plots below. */}
      <Text size="xs" c="dimmed" style={{ lineHeight: 1.35, minHeight: "2.7em" }}>
        {highlightCell
          ? `${names[highlightCell.i]} ${xLabel}, ${names[highlightCell.j]} ${yLabel}: ${cellCount.toLocaleString()} places (${n ? Math.round((100 * cellCount) / n) : 0}%)`
          : `Lines indicate ${unequal ? "the percentiles marked" : "quartiles"}. Pearson r = ${coef(shownFit?.r)}; Spearman r = ${coef(shownRho)}.${removed ? ` ${removed.toLocaleString()} places with 0 values removed.` : ""}`}
      </Text>
      {note && <Text size="xs" c="dimmed" mt={4} style={{ lineHeight: 1.35 }}>{note}</Text>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <svg width="12" height="12" style={{ flexShrink: 0, display: "block", borderRadius: 2, border: `1px solid ${isDark ? "#777" : "#999"}` }}>
          <rect width="12" height="12" fill="url(#noDataHatch)" />
        </svg>
        <Text size="xs" c="dimmed">No data on either variable</Text>
      </div>
    </div>
  );
}
