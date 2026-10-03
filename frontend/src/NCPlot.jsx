// src/NCPlot.jsx
import React, { useEffect, useRef } from "react";
import echarts from "./echartsCore";
import { Text, useMantineColorScheme } from "@mantine/core";
import { seriesColors } from "./config";

/**
 * NCPlot: histogram of non-count values across all geos
 * with a text summary of focal + reference values beneath.
 *
 * Props:
 *  - rows: [{ geosid, geoname, prname, value }] — one entry per geography,
 *    value already joined/derived client-side (no geometry involved)
 *  - focalGeosid: geosid for focal place
 *  - refGeosid: geosid for reference place (optional)
 *  - focalLabel: optional override for focal name
 *  - refLabel: optional override for reference name
 *  - themeLabel: human-readable theme label
 *  - codeLabel: human-readable code / category label
 */
function NCPlot({
  rows,
  focalGeosid,
  refGeosid,
  focalLabel,
  refLabel,
  refValueOverride,
  themeLabel,
  codeLabel,
  useLogScale,
  year,
}) {
  const chartRef = useRef(null);
  const { colorScheme } = useMantineColorScheme();

  function asinhTransform(x) {
    const v = Number(x);
    if (!Number.isFinite(v)) return null;
    return Math.asinh(v);
  }

  // Pretty formatting for numeric values
  const formatVal = (v) => {
    if (v == null || Number.isNaN(Number(v))) return "NA";
    const x = Number(v);
    if (Math.abs(x) >= 1000) return x.toLocaleString();
    if (Math.abs(x) >= 10) return x.toFixed(0);
    return x.toFixed(2);
  };

  /**
   * Build { value, label } for a given geosid:
   *  - value from the joined rows, unless overrideValue is provided
   *  - label from geoname + prname if available
   *  - falls back to provided label prop, then geosid string
   */
  const getInfoForGeosid = (geosid, labelOverride, overrideValue) => {
    if (!geosid || !rows?.length) {
      return {
        value: overrideValue ?? null,
        label: labelOverride ?? null,
      };
    }

    const row = rows.find((r) => String(r.geosid) === String(geosid)) || {};
    const rawVal = Number(row.value);
    const baseValue = Number.isFinite(rawVal) ? rawVal : null;
    const value = overrideValue != null ? overrideValue : baseValue;

    const geoName = row.geoname || null;
    const prName = row.prname || null;

    let label;
    if (labelOverride) {
      label = labelOverride;
    } else if (geoName && prName) {
      label = `${geoName}, ${prName}`;
    } else if (geoName) {
      label = geoName;
    } else if (prName) {
      label = prName;
    } else if (geosid) {
      label = String(geosid);
    } else {
      label = null;
    }

    return { value, label };
  };

  const focalInfo = getInfoForGeosid(focalGeosid, focalLabel, null);
  const refInfo = getInfoForGeosid(refGeosid, refLabel, refValueOverride);
  useEffect(() => {
    const dom = chartRef.current;
    if (!dom || !rows?.length) return;

    let chart = echarts.getInstanceByDom(dom);
    if (chart) chart.dispose();
    chart = echarts.init(dom, colorScheme === "dark" ? "dark" : null);

    // Extract all numeric values for the histogram
    const rawVals = rows
      .map((r) => Number(r.value))
      .filter((v) => Number.isFinite(v));


    const vals =
      useLogScale
        ? rawVals.map(asinhTransform)
        : rawVals;

    if (!vals.length) {
      chart.clear();
      return;
    }

    // Basic binning – Sturges rule, doubled. Sturges assumes roughly normal
    // data; the non-count measures (density, dwelling value) are strongly
    // right-skewed, so its bin count buries the long tail in a handful of
    // wide bins. Doubling it resolves the tail without making the bars noisy.
    const n = vals.length;
    const nbins = Math.max(
      12,
      Math.min(60, Math.ceil(Math.log2(n) + 1) * 2)
    );

    // Loop rather than Math.min(...vals): spreading thousands of values risks
    // a call-stack overflow and walks the array twice.
    let minV = Infinity;
    let maxV = -Infinity;
    for (const v of vals) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const span = maxV - minV || 1;
    const binWidth = span / nbins;

    // counts per bin
    const counts = new Array(nbins).fill(0);
    vals.forEach((v) => {
      let idx = Math.floor((v - minV) / binWidth);
      if (idx >= nbins) idx = nbins - 1;
      if (idx < 0) idx = 0;
      counts[idx] += 1;
    });

    // bin centers for plotting
    const centers = counts.map(
      (_, i) => minV + (i + 0.5) * binWidth
    );

    const barData = centers.map((c, i) => [c, counts[i]]);

    // x-axis padding, so the first and last bars are not flush against the
    // frame. The padded ends are breathing room, not readings — for a measure
    // whose minimum is zero the low end sits below zero, a value that cannot
    // occur — so the axis suppresses the labels at both extremes and draws no
    // ticks. The nice round labels in between (0, 3,000, …) carry the scale.
    const xMin = minV - 0.05 * span;
    const xMax = maxV + 0.05 * span;

    // The padded ends are breathing room, not readings, and for a measure whose
    // minimum is zero the low end sits below zero — a value that cannot occur.
    // ECharts' showMinLabel/showMaxLabel do not suppress them on a value axis
    // with an explicit min/max (verified: both were still painted), so blank
    // them in the formatter instead. Everything between is a nice round tick
    // and keeps ECharts' own comma grouping.
    const EDGE_EPS = span * 1e-6;
    const isAxisEdge = (v) =>
      Math.abs(v - xMin) < EDGE_EPS || Math.abs(v - xMax) < EDGE_EPS;
    const xAxisLabel = (v) => (isAxisEdge(v) ? "" : Number(v).toLocaleString("en-CA"));

    // MarkLines must live on the same scale as the binned values.
    const toAxisX = (v) => (useLogScale ? asinhTransform(v) : v);
    const focalLineX =
      focalInfo.value != null && Number.isFinite(focalInfo.value)
        ? toAxisX(focalInfo.value)
        : null;
    const refLineX =
      refInfo.value != null && Number.isFinite(refInfo.value)
        ? toAxisX(refInfo.value)
        : null;

    // Rotated markLine labels sit alongside the line ("insideEndTop" = left of
    // a vertical line, "insideEndBottom" = right). Each label goes on the
    // outward side of its line — leftmost line labelled left, rightmost right —
    // so the two labels can never collide however close the lines are.
    const hasFocalLine = focalLineX != null;
    const hasRefLine = refLineX != null;
    const bothLines = hasFocalLine && hasRefLine;
    const focalLabelPos =
      bothLines && focalLineX > refLineX ? "insideEndBottom" : "insideEndTop";
    const refLabelPos =
      bothLines && refLineX >= focalLineX ? "insideEndBottom" : "insideEndTop";

    const option = {
      backgroundColor: "transparent",
      // Plots redraw on every selection change; the transition animation
      // only delays the reading and makes the plots settle out of step.
      animation: false,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const p = params[0];
          if (!p) return "";
          const [center, count] = p.value;
          const left = center - binWidth / 2;
          const right = center + binWidth / 2;
          return [
            `${codeLabel || themeLabel || "Value"}`,
            `Bin: [${left.toFixed(2)}, ${right.toFixed(2)})`,
            `Count: ${count}`,
          ].join("<br/>");
        },
      },
      grid: {
        top: 30,
        bottom: 45,
        left: 52,
        right: 10,
      },
      xAxis: {
        type: "value",
        min: xMin,
        max: xMax,
        axisLabel: { rotate: 90, formatter: xAxisLabel },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colorScheme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" } },
      },
      yAxis: {
        type: "value",
        name: "Count of geographic units",
        // The gridlines already carry the scale; the ticks only add clutter.
        axisTick: { show: false },
        // ECharts anchors a value y-axis at x = 0 rather than at the frame
        // edge, so once the x axis is padded below zero this line lands inside
        // the plot as a stray dark vertical. The gridlines do its job.
        axisLine: { show: false },
        splitLine: { lineStyle: { color: colorScheme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" } },
      },
      series: [
        {
          name: "Distribution",
          type: "bar",
          barWidth: "90%",
          // Lighter than ECharts' default #5470c6, which sat at 1.17:1 against
          // the focal rule drawn over it -- the line was effectively invisible
          // inside a tall bar. This reads 2.65:1 against the focal green and
          // 3.31:1 against the comparison magenta.
          itemStyle: { color: "#9db4ef" },
          data: barData,
          markLine: {
            symbol: "none",
            silent: true,
            data: [
              hasFocalLine
                ? {
                    xAxis: focalLineX,
                    lineStyle: { type: "solid", color: seriesColors(colorScheme).focal, width: 2 },
                    label: {
                      show: true,
                      formatter: "Prim",
                      position: focalLabelPos,
                      distance: 6,
                      color: seriesColors(colorScheme).focal,
                      fontSize: 10,
                      fontWeight: "bold",
                    },
                  }
                : null,
              hasRefLine
                ? {
                    xAxis: refLineX,
                    lineStyle: { type: "dashed", color: seriesColors(colorScheme).ref, width: 2 },
                    label: {
                      show: true,
                      formatter: "Comp",
                      position: refLabelPos,
                      distance: 6,
                      color: seriesColors(colorScheme).ref,
                      fontSize: 10,
                      fontWeight: "bold",
                    },
                  }
                : null,
            ].filter(Boolean),
          },
        },
      ],
    };

    chart.setOption(option, true);

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
  }, [rows, themeLabel, codeLabel, focalInfo.value, refInfo.value, colorScheme, useLogScale]);

  if (!rows?.length) return null;

  // Gate on the geosid as well as the label: the label can outlive a cleared
  // selection for a render, and a cleared geography must not print as
  // "<name>: NA".
  const showFocal = !!focalGeosid && !!focalInfo.label;
  // Gate on the geosid, not the label: App passes a "Comparison geography"
  // fallback label, so a label test is always true and rendered a placeholder
  // line reading "Comparison geography: NA" with nothing selected.
  const showRef = !!refGeosid && !!refInfo.label;

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
      {(showFocal || showRef) && (
        <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6, flexShrink: 0 }}>
          {showFocal && (
            <div>
              <strong style={{ color: seriesColors(colorScheme).focal }}>{focalInfo.label}</strong>
              {": "}{formatVal(focalInfo.value)}
            </div>
          )}
          {showRef && (
            <div>
              <strong style={{ color: seriesColors(colorScheme).ref }}>{refInfo.label}</strong>
              {": "}{formatVal(refInfo.value)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NCPlot;