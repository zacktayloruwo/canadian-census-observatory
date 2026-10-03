// src/OrdPlot.jsx
import React, { useEffect, useRef } from "react";
import echarts from "./echartsCore";
import { Text, useMantineColorScheme } from "@mantine/core";
import { seriesColors } from "./config";

function OrdPlot({ data }) {
  if (
    !data ||
    !Array.isArray(data.categories) ||
    data.categories.length === 0
  ) {
    return null;
  }

  const chartRef = useRef(null);
  const { colorScheme } = useMantineColorScheme();

  const {
    categories,
    focal = [],
    ref = [],
    focalLabel = "Focal geography",
    refLabel = "Reference geography",
    year,
  } = data;

  // coerce to numeric arrays aligned with categories
  const focalSeries = categories.map((_, i) =>
  Number.isFinite(Number(focal[i])) ? Number(focal[i]) : 0
);
// App passes null when no comparison is selected. It cannot be inferred from
// the payload: /api/os-plot returns a zero-filled ref array in that case, and
// zeros are finite, so any value test here would see a real series.
// Thin space between the two bars of a pair, as a share of bar width.
const BAR_GAP = "20%";

const hasRef =
  Array.isArray(ref) && ref.some((v) => Number.isFinite(Number(v)));



useEffect(() => {
  const dom = chartRef.current;
  const refSeries = hasRef
    ? categories.map((_, i) => (Number.isFinite(Number(ref[i])) ? Number(ref[i]) : 0))
    : [];
  if (!dom) return;

  let chart = echarts.getInstanceByDom(dom);
  if (chart) chart.dispose();

  chart = echarts.init(dom, colorScheme === "dark" ? "dark" : null);

  // 👇 build option as a function so we can recompute on resize
  const buildOption = () => {
    // -------- bar geometry --------
    // ECharts fits the bars to the axis; we only cap them and set the gaps.
    // The previous code computed a pixel width with an 8px floor, which at 21
    // categories asked for two 8px bars in a ~10px slot -- ECharts resolved
    // that by drawing them on top of each other.
    //
    //   BAR_GAP           thin space between the two bars of a pair
    //   barCategoryGap    space between one category and the next
    const barCategoryGap = hasRef ? "25%" : "20%";

    // -------- y-axis scaling --------
    const allValues = [
      ...focalSeries,
      ...(hasRef ? refSeries : []),
    ].filter((v) => Number.isFinite(v));

    const yMax =
      allValues.length > 0
        ? Math.ceil((Math.max(...allValues) * 1.1) / 5) * 5
        : 100;

    return {
      backgroundColor: "transparent",
      // Plots redraw on every selection change; the transition animation
      // only delays the reading and makes the plots settle out of step.
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        appendToBody: true,
        formatter: (params) => {
          const head = params[0]?.name ?? "";
          const rows = params.map((p) => {
            const v = Number(p.value);
            const vStr = Number.isFinite(v) ? v.toFixed(1) : "NA";
            return `${p.seriesName}: ${vStr}%`;
          });
          return `${head}<br/>${rows.join("<br/>")}`;
        },
      },
      legend: { show: false },
      grid: {
        top: 10,
        bottom: 60,
        left: 46,
        right: 10,
      },
      barCategoryGap,
      xAxis: {
        type: "category",
        data: categories,
        axisLabel: { rotate: 90 },
        axisTick: { alignWithLabel: true },
        boundaryGap: true,
      },
      yAxis: {
        type: "value",
        min: 0,
        max: yMax,
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
      series: [
        {
          name: focalLabel,
          type: "bar",
          data: focalSeries,
          barMaxWidth: 40,
          ...(hasRef ? { barGap: BAR_GAP } : {}),
          color: seriesColors(colorScheme).focal,
          label: {
            show: true,
            position: "top",
            fontSize: 9,
            formatter: (p) => `${Number(p.value).toFixed(0)}%`,
          },
          labelLayout: { hideOverlap: true },
        },
        hasRef && {
          name: refLabel,
          type: "bar",
          data: refSeries,
          barMaxWidth: 40,
          barGap: BAR_GAP,
          color: seriesColors(colorScheme).ref,
          label: {
            show: true,
            position: "top",
            fontSize: 9,
            formatter: (p) => `${Number(p.value).toFixed(0)}%`,
          },
          labelLayout: { hideOverlap: true },
        },
      ].filter(Boolean),
    };
  };

  // initial render
  chart.setOption(buildOption());

  // Defer resize to next animation frame so the browser has finished
  // propagating the parent container's new CSS dimensions before ECharts
  // measures dom.clientWidth to recompute barWidth.
  // Two frames: the first can land before the flex parent has settled its
  // height, which is how a chart ends up measured at its minHeight and leaves
  // a band of empty space under itself.
  const refit = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    chart.resize();
    chart.setOption(buildOption(), true);
  }));

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
  categories,
  focalSeries,
  ref,
  focalLabel,
  refLabel,
  hasRef,
  colorScheme,
]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Text size="sm" fw={600} mb={4} style={{ flexShrink: 0 }}>{year}</Text>
      <div
        ref={chartRef}
        style={{
          width: "100%",
          flex: 1,
          minHeight: 200,
        }}
      />
    </div>
  );
}

export default OrdPlot;