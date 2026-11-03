// src/BivariateLegend.jsx
//
// The bivariate map's key: a square grid, low-low at bottom left, with the break
// values for each axis. Hovering or focusing a cell highlights its units on
// the map and gives their count, which decodes a class without matching colours
// and shows how unevenly the units fall across the grid.

import React, { forwardRef } from "react";
import { classNames, rowOf } from "./bivariate";

const GRID_PX = 80;   // the same size at 3x3 and 4x4

function fmt(v, percent) {
  const x = Number(v);
  if (percent) return `${x.toFixed(1)}%`;
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString();
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

// One { name, range } per class, high to low: "Low: 0", "Mid: up to 1.2%", "High: above 1.2%".
function classLabels(b, percent) {
  const f = (v) => fmt(v, percent);
  const names = classNames(b.n);
  const last = b.upper.length;
  const out = [];
  for (let k = last; k >= 0; k--) {
    let range;
    if (k === last) range = `above ${f(b.upper[last - 1])}`;
    else if (k === 0) range = b.upper[0] === b.min ? f(b.min) : `up to ${f(b.upper[0])}`;
    else if (k === 1 && b.upper[0] === b.min) range = `up to ${f(b.upper[1])}`;
    else range = `${f(b.upper[k - 1])} to ${f(b.upper[k])}`;
    const name = names[rowOf(k, b)];
    out.push({ name: name[0].toUpperCase() + name.slice(1), range });
  }
  return out;
}

function Axis({ title, labels, muted }) {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.3, minWidth: 0 }}>
      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>{title}</div>
      {labels.map((l) => (
        <div key={l.name} style={{ color: muted, fontVariantNumeric: "tabular-nums" }}>{l.name}: {l.range}</div>
      ))}
    </div>
  );
}

const BivariateLegend = forwardRef(function BivariateLegend(
  { bivariate, xLabel, yLabel, year, xPercent, yPercent, note, isDark, highlightCell, onHighlightCell },
  ref,
) {
  const { breaksX, breaksY, counts, n, size, colors } = bivariate;
  const names = classNames(size);
  const rows = [...Array(size).keys()];
  const cellPx = Math.floor(GRID_PX / size);
  const muted = isDark ? "#bbb" : "#555";
  const unequal = breaksX.kind !== "equal" || breaksY.kind !== "equal";
  const cell = highlightCell;
  const cellCount = cell ? counts[cell.i + size * cell.j] : 0;
  const describe = (i, j) => `${names[i]} ${xLabel}, ${names[j]} ${yLabel}`;

  return (
    <div
      ref={ref}
      style={{
        pointerEvents: "auto",
        width: 344,
        boxSizing: "border-box",
        padding: "9px 12px 8px",
        border: `1px solid ${isDark ? "#555" : "#ddd"}`,
        borderRadius: 6,
        background: isDark ? "#1e1e1e" : "#ffffff",
        color: isDark ? "#e8e8e8" : "#222",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, lineHeight: 1.3 }}>
        {xLabel} × {yLabel}{year ? ` · ${year}` : ""}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ flexShrink: 0 }}>
          <div
            role="group"
            aria-label={`Colour key: ${xLabel} from low to high, left to right, and ${yLabel} from low to high, bottom to top`}
            style={{ display: "grid", gridTemplateColumns: `repeat(${size}, ${cellPx}px)`, gap: 1, background: isDark ? "#555" : "#999", border: `1px solid ${isDark ? "#777" : "#999"}` }}
            onMouseLeave={() => onHighlightCell?.(null)}
          >
            {[...rows].reverse().flatMap((j) => rows.map((i) => {
              const active = cell?.i === i && cell?.j === j;
              return (
                <button
                  key={`${i}-${j}`}
                  type="button"
                  aria-label={`${describe(i, j)}: ${counts[i + size * j].toLocaleString()} places`}
                  title={describe(i, j)}
                  onMouseEnter={() => onHighlightCell?.({ i, j })}
                  onFocus={() => onHighlightCell?.({ i, j })}
                  onBlur={() => onHighlightCell?.(null)}
                  style={{
                    width: cellPx, height: cellPx, padding: 0, border: "none", cursor: "pointer",
                    background: colors[i + size * j],
                    outline: active ? `2px solid ${isDark ? "#fff" : "#000"}` : "none",
                    outlineOffset: -2,
                  }}
                />
              );
            }))}
          </div>
          <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>first →, second ↑</div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <Axis title={`↑ ${yLabel}`} labels={classLabels(breaksY, yPercent)} muted={muted} />
          <Axis title={`→ ${xLabel}`} labels={classLabels(breaksX, xPercent)} muted={muted} />
        </div>
      </div>

      <div style={{ fontSize: 12, color: muted, marginTop: 6, minHeight: 16, lineHeight: 1.35 }}>
        {cell
          ? `${describe(cell.i, cell.j)}: ${cellCount.toLocaleString()} places (${n ? Math.round((100 * cellCount) / n) : 0}%)`
          : unequal
            ? "Classes are unequal: many places share the lowest value."
            : `Each variable is split into ${size === 4 ? "quarters" : "thirds"}.`}
      </div>
      {note && <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{note}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <svg width="14" height="14" style={{ flexShrink: 0, display: "block", borderRadius: 2, border: `1px solid ${isDark ? "#777" : "#999"}` }}>
          <rect width="14" height="14" fill="url(#noDataHatch)" />
        </svg>
        <span style={{ fontSize: 12 }}>No data on either variable</span>
      </div>
    </div>
  );
});

export default BivariateLegend;
