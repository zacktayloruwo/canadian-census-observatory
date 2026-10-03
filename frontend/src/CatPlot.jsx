// src/CatPlot.jsx
import React, { useEffect, useRef } from "react";
import echarts from "./echartsCore";
import { Text, useMantineColorScheme } from "@mantine/core";

// Height one legend row occupies: itemHeight + itemGap, matched to the legend
// settings below so the grid reserves exactly what the legend uses.
const LEGEND_ROW = 16;

// hasRef: the CURRENT comparison selection. The payload may still carry a
// ref series from before the comparison was cleared, so the payload alone is
// not trusted for this.
function CatPlot({ data, hasRef: hasRefSelection = true }) {
  if (!data || !data.categories || data.categories.length === 0) {
    return null;
  }

  const hasRef = hasRefSelection && !!data.ref;
  const chartRef = useRef(null);
  const { colorScheme } = useMantineColorScheme();

  // Build categories array
  const categories = data.categories.map((c) => ({
    name: c.t_name,
    focal: c.focal_pct == null ? 0 : Number(c.focal_pct),
    ref: hasRef && c.ref_pct != null ? Number(c.ref_pct) : 0,
  }));

  const palette = [
    "#e41a1c",
    "#377eb8",
    "#4daf4a",
    "#984ea3",
    "#ff7f00",
    "#bbbbbb",
  ];

  const focalName = data.focal?.label || "Focal geography";
  const refName = data.ref?.label || "Reference geography";

  useEffect(() => {
  const dom = chartRef.current;
  if (!dom) return;

  let chart = echarts.getInstanceByDom(dom);
  if (chart) chart.dispose();

  chart = echarts.init(dom, colorScheme === "dark" ? "dark" : null);

  // Dark text on light segments, white text on dark ones.
  const labelColorFor = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum > 0.45 ? "#333333" : "#ffffff";
  };

  const series = categories.map((cat, idx) => ({
    name: cat.name,
    type: "bar",
    stack: "total",
    barWidth: 25,
    itemStyle: {
      color: palette[idx % palette.length],
      borderColor: "#ffffff",
      borderWidth: 1,
    },
    emphasis: {
      focus: "series",
    },
    // The last series carries the row-name label (top right); the others show
    // their percentage inside the segment when it is wide enough to fit.
    label:
      idx === categories.length - 1
        ? {
            show: true,
            position: "right",
            align: "right",
            verticalAlign: "top",
            offset: [-5, -30],
            formatter: (params) => params.name,
          }
        : {
            show: true,
            position: "inside",
            fontSize: 9,
            color: labelColorFor(palette[idx % palette.length]),
            formatter: (params) =>
              Number(params.value) >= 8 ? `${Number(params.value).toFixed(0)}%` : "",
          },
    data: hasRef ? [cat.focal, cat.ref] : [cat.focal],
  }));

  const option = {
    backgroundColor: "transparent",
    // Plots redraw on every selection change; the transition animation
    // only delays the reading and makes the plots settle out of step.
    animation: false,
    tooltip: {
      trigger: "item",
      appendToBody: true,
      formatter: (params) => {
        const rowLabel = params.name;
        const catName = params.seriesName;
        const v = params.value;
        const vStr =
          v == null || isNaN(v) ? "NA" : `${Number(v).toFixed(1)}%`;
        return `${rowLabel}<br/>${catName}: ${vStr}`;
      },
    },
    legend: {
      orient: "vertical",
      bottom: 0,
      left: 0,
      // One row per category, so the default 10px gap dominates the plot in a
      // narrow panel. Marker and gap both come down; LEGEND_ROW below reserves
      // the matching space in the grid.
      itemGap: 3,
      itemHeight: 10,
      itemWidth: 14,
      textStyle: { fontSize: 11 },
    },
    grid: {
      left: 4,
      right: 10,
      top: 10,
      bottom: categories.length * LEGEND_ROW + 50,
    },
    xAxis: {
      type: "value",
      max: 100,
      axisLabel: { formatter: "{value}%" },
      splitLine: {
        lineStyle: {
          color:
            colorScheme === "dark"
              ? "rgba(255,255,255,0.1)"
              : "rgba(0,0,0,0.08)",
        },
      },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: hasRef ? [focalName, refName] : [focalName],
      axisLabel: { show: false },
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
}, [categories, focalName, refName, hasRef, colorScheme]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Text size="sm" fw={600} mb={4} style={{ flexShrink: 0 }}>{data.year}</Text>
      <div
        style={{
          width: "100%",
          flex: 1,
          minHeight: (hasRef ? 90 : 70) + categories.length * LEGEND_ROW + 70,
        }}
        ref={chartRef}
      />
    </div>
  );
}

export default CatPlot;