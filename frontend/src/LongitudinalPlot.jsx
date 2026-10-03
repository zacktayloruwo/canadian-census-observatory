// src/LongitudinalPlot.jsx
import React, { useEffect, useRef } from "react";
import echarts from "./echartsCore";
import { Text, useMantineColorScheme } from "@mantine/core";
import { seriesColors } from "./config";

/**
 * LongitudinalPlot:
 *   - Shows focal vs reference values over time
 *   - Uses seriesColors(colorScheme) from config.js: the focal series solid,
 *     the comparison series dashed. Tone flips with the theme.
 *   - Respects valueMode: "raw" | "percent" (labels & formatting)
 *
 * Props:
 *  - seriesPayload: {
 *      focal: { label, series: [{ time, value }, ...] },
 *      ref:   { label, series: [{ time, value }, ...] } | null
 *    }
 *  - valueMode: "raw" | "percent"
 *  - censusYears: every census year that exists at this level (from
 *    /api/code-years). A year in this list with no value for a series is
 *    plotted as an explicit null so the line BREAKS there instead of being
 *    drawn straight across the gap — a unit absent from a census must never
 *    read as a value.
 */
function LongitudinalPlot({ seriesPayload, valueMode, useLogScale, censusYears = [] }) {
  const chartRef = useRef(null);
  const { colorScheme } = useMantineColorScheme();

  function asinhTransform(x) {
    const v = Number(x);
    if (!Number.isFinite(v)) return null;
    return Math.asinh(v);
  }

  const isRaw = valueMode === "raw"; 

  if (!seriesPayload || !seriesPayload.focal) {
    return null;
  }

  const focal = seriesPayload.focal;
  const ref = seriesPayload.ref || null;

  const focalSeries = focal.series || [];
  const refSeries = ref?.series || [];

  // Years with a value in either series set the plotted extent...
  const yearsSet = new Set();
  focalSeries.forEach((p) => yearsSet.add(Number(p.time)));
  refSeries.forEach((p) => yearsSet.add(Number(p.time)));
  const dataYears = Array.from(yearsSet).filter((y) => Number.isFinite(y)).sort((a, b) => a - b);

  // If fewer than 2 years, don't bother plotting
  if (dataYears.length < 2) {
    return null;
  }

  const minYear = dataYears[0];
  const maxYear = dataYears[dataYears.length - 1];

  // ...and every census year inside that extent is a plotted position, so a
  // census the unit missed becomes a gap rather than a bridge.
  const censusInRange = (censusYears || [])
    .map(Number)
    .filter((y) => Number.isFinite(y) && y >= minYear && y <= maxYear);
  const allYears = Array.from(new Set([...dataYears, ...censusInRange])).sort((a, b) => a - b);

  // Pad the year axis so the first and last markers are not flush against the
  // frame, matching the distribution plot. The padded ends are breathing room
  // and must never be labelled — 2010.5 is not a census year — so ticks and
  // labels are pinned to the real years instead of being generated from the
  // extent. ECharts derives the gridlines from axisTick.customValues too
  // (createAxisTicks reads that model whichever component asks), so one list
  // keeps labels and gridlines on the same years.
  const yearPad = Math.max(0.5, (maxYear - minYear) * 0.05);
  const xMinYear = minYear - yearPad;
  const xMaxYear = maxYear + yearPad;

  // Build [year, value] pairs — ECharts value axis uses these directly.
  // A census year without a finite value is an explicit null point: with
  // connectNulls off, ECharts breaks the line there and draws no marker.
  const toPoints = (pts) =>
    allYears.map((y) => {
      const row = pts.find((p) => Number(p.time) === y);
      const v = row == null ? null : Number(row.value);
      return [y, Number.isFinite(v) ? v : null];
    });
  const focalData = toPoints(focalSeries);
  const refData = ref ? toPoints(refSeries) : [];

  const focalPlotData = useLogScale && isRaw
    ? focalData.map(([y, v]) => [y, v == null ? null : asinhTransform(v)])
    : focalData;

  const refPlotData = useLogScale && isRaw
    ? refData.map(([y, v]) => [y, v == null ? null : asinhTransform(v)])
    : refData;

  const formatVal = (v) => {
    if (v == null || Number.isNaN(Number(v))) return "NA";
    const x = Number(v);
    if (valueMode === "percent") {
      return `${x.toFixed(1)}%`;
    }
    if (Math.abs(x) >= 1000) return x.toLocaleString();
    if (Math.abs(x) >= 10) return x.toFixed(0);
    return x.toFixed(2);
  };

  useEffect(() => {
  const dom = chartRef.current;
  if (!dom) return;

  let chart = echarts.getInstanceByDom(dom);
  if (chart) chart.dispose();

  chart = echarts.init(dom, colorScheme === "dark" ? "dark" : null);

  const series = [
    {
      name: focal.label || "Focal",
      type: "line",
      data: focalPlotData,
      connectNulls: false,
      itemStyle: { color: seriesColors(colorScheme).focal },
      lineStyle: { width: 3, color: seriesColors(colorScheme).focal },
      symbol: "circle",
      symbolSize: 8,
    },
  ];

  if (ref && refPlotData.some((v) => v != null)) {
    series.push({
      name: ref.label || "Reference",
      type: "line",
      data: refPlotData,
      connectNulls: false,
      itemStyle: { color: seriesColors(colorScheme).ref },
      lineStyle: { width: 3, color: seriesColors(colorScheme).ref, type: "dashed" },
      symbol: "circle",
      symbolSize: 8,
    });
  }

  const option = {
    backgroundColor: "transparent",
    // Plots redraw on every selection change; the transition animation
    // only delays the reading and makes the plots settle out of step.
    animation: false,
    tooltip: {
      trigger: "axis",
      appendToBody: true,
      extraCssText: "z-index: 9999;",
      formatter: (params) => {
        if (!params || !params.length) return "";
        const year = params[0].axisValue;
        const lines = [`Year: ${Math.round(year)}`];
        params.forEach((p) => {
          // data is [year, value] for value-axis series
          const v = Array.isArray(p.data) ? p.data[1] : p.data;
          lines.push(`${p.marker} ${p.seriesName}: ${formatVal(v)}`);
        });
        return lines.join("<br/>");
      },
    },
    legend: { show: false },
    grid: {
      top: 10,
      left: 52,
      right: 10,
      bottom: 50,
    },
    xAxis: {
      type: "value",
      min: xMinYear,
      max: xMaxYear,
      axisLabel: {
        rotate: 90,
        customValues: allYears,
        hideOverlap: true,
        formatter: (val) => String(Math.round(val)),
      },
      axisTick: { show: false, customValues: allYears },
    },
    yAxis: {
      type: "value",
      // The gridlines already carry the scale; the ticks only add clutter.
      axisTick: { show: false },
      // ECharts anchors a value y-axis at x = 0 rather than at the frame edge,
      // so this line is only ever incidental chrome here. Dropped to match the
      // distribution plot.
      axisLine: { show: false },
      splitLine: {
        lineStyle: {
          color:
            colorScheme === "dark"
              ? "rgba(255,255,255,0.1)"
              : "rgba(0,0,0,0.08)",
        },
      },
      axisLabel:
        valueMode === "percent"
          ? { formatter: (val) => `${Number(val).toFixed(1)}%` }
          : {},
    },
    series,
  };

  chart.setOption(option);

  // Defer resize to next animation frame so the browser has finished
  // propagating the parent container's new CSS dimensions before ECharts
  // measures the element — prevents measuring the pre-resize stale size.
  // Two frames: the first can land before the flex parent has settled its
  // height, which is how a chart ends up measured at its minHeight and leaves
  // a band of empty space under itself.
  const refit = () => requestAnimationFrame(() => requestAnimationFrame(() => chart.resize()));

  const observer = new ResizeObserver(refit);
  observer.observe(dom);

  // Correct an initial measure taken before the layout settled. Without this a
  // chart mounted into a still-collapsing flex row keeps that first size,
  // because nothing resizes it afterwards for the observer to catch.
  refit();

  return () => {
    observer.disconnect();
    chart.dispose();
  };
}, [
  focal,
  ref,
  focalPlotData,
  refPlotData,
  minYear,
  maxYear,
  valueMode,
  colorScheme,
  useLogScale,
  seriesPayload
]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Text size="sm" fw={600} mb={4} style={{ flexShrink: 0 }}>Change over time</Text>
      <div
        ref={chartRef}
        style={{
          width: "100%",
          flex: 1,
          minHeight: 180,
        }}
      />
    </div>
  );
}

export default LongitudinalPlot;