// src/YearCoverage.jsx
//
// The coverage strip that flies out beside the Year pulldown.
//
// It answers the question a pulldown structurally cannot: for THIS variable,
// which census years do I actually have? Every census year at the current
// level is a dot on a real-time axis, and every one is labelled — the years
// with data as bordered, clickable chips, the years without as plain text.
// The border is what says "you can pick this", so it is drawn around the text
// rather than around a fixed-width box; a fixed box clipped four digits at
// 11px.
//
// Labels stagger above and below the line when they would collide, which is
// what lets the strip stay ~88px tall no matter how tight the years cluster.
// The strip always spans the full census range rather than rescaling to the
// years one variable happens to have, so coverage is comparable at a glance
// when you switch variables — which is the whole point of the control.

import React from "react";

// Exported so the flyout can centre the axis line — not the panel box — on
// the button that opens it.
export const AXIS_Y = 44;
const HEIGHT = 88;
const BOX_H = 22;
// Layout-only estimate: the chips size to their own text, but the stagger has
// to decide before the browser measures. Four digits at 11px plus padding and
// border measures 40-42px in the running app; erring high only staggers a
// little sooner, whereas erring low lets labels touch.
const EST_W = 42;
const PAD = 4;

function palette(isDark) {
  return isDark
    ? {
        chipBg: "#25262b", chipStroke: "#6c7075", chipFg: "#a5d4ff",
        offFg: "#9aa0a6",
        dot: "#228be6",
        sel: "#1864ab", selFg: "#ffffff",
        axis: "#5c5f66",
      }
    : {
        chipBg: "#ffffff", chipStroke: "#868e96", chipFg: "#1864ab",
        offFg: "#5c636a",
        dot: "#228be6",
        sel: "#1864ab", selFg: "#ffffff",
        axis: "#adb5bd",
      };
}

export default function YearCoverage({
  census = [],
  available = [],
  value,
  onChange,
  colorScheme = "light",
  width = 640,
}) {
  const pal = palette(colorScheme === "dark");

  if (census.length === 0) return null;

  const x0 = 24;
  const x1 = Math.max(x0 + 40, width - 24);
  const span = x1 - x0;

  const lo = census[0];
  const hi = census[census.length - 1];
  const range = hi - lo || 1;
  const px = (y) => Math.round((x0 + ((y - lo) / range) * span) * 10) / 10;

  const availSet = new Set(available.map(Number));

  // Row 0 sits below the line, row 1 above it. Every census year is labelled,
  // so the stagger runs over all of them, not just the selectable ones.
  const belowY = AXIS_Y + 14;
  const aboveY = AXIS_Y - 36;
  const lastRight = [-Infinity, -Infinity];

  const items = census.map((y) => {
    const year = Number(y);
    const x = px(year);
    const left = x - EST_W / 2;
    let row = 0;
    if (left < lastRight[0] + PAD) row = 1;
    if (row === 1 && left < lastRight[1] + PAD) row = 0;
    lastRight[row] = left + EST_W;

    const selected = year === Number(value);
    const has = availSet.has(year);
    const boxY = row === 0 ? belowY : aboveY;

    return {
      year,
      x,
      boxY,
      selected,
      has,
      leadY1: AXIS_Y,
      leadY2: row === 0 ? boxY : boxY + BOX_H,
      // Every part of a year's mark — tick, dot, chip border and label text —
      // is one colour, so the eye groups them without having to be told.
      lead: selected ? pal.sel : has ? pal.dot : pal.axis,
      // The unavailable years are scale, not data: same colour as the axis and
      // a thinner tick, so they recede behind the years you can actually pick.
      leadW: has || selected ? 2 : 1.25,
      dotR: selected ? 8 : 4,
      // Unavailable dots take the axis colour: they are part of the scale, not
      // a value on it.
      dotFill: selected ? pal.sel : has ? pal.dot : pal.axis,
    };
  });

  const labelBase = {
    position: "absolute",
    height: BOX_H,
    transform: "translateX(-50%)",
    padding: "0 4px",
    margin: 0,
    borderRadius: 5,
    font: "inherit",
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
    lineHeight: "20px",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ position: "relative", width, height: HEIGHT }}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        style={{ display: "block", position: "absolute", left: 0, top: 0 }}
        aria-hidden="true"
      >
        {items.map((it) => (
          <line key={`lead-${it.year}`} x1={it.x} y1={it.leadY1} x2={it.x} y2={it.leadY2} stroke={it.lead} strokeWidth={it.leadW} />
        ))}
        <line x1={x0} y1={AXIS_Y} x2={x1} y2={AXIS_Y} stroke={pal.axis} strokeWidth="1" />
        {items.map((it) => (
          <circle key={`dot-${it.year}`} cx={it.x} cy={AXIS_Y} r={it.dotR} fill={it.dotFill} />
        ))}
      </svg>

      {items.map((it) =>
        it.has ? (
          <button
            key={`lbl-${it.year}`}
            type="button"
            onClick={() => onChange?.(it.year)}
            aria-pressed={it.selected}
            style={{
              ...labelBase,
              left: it.x,
              top: it.boxY,
              border: `1px solid ${it.selected ? pal.sel : pal.dot}`,
              background: it.selected ? pal.sel : pal.chipBg,
              color: it.selected ? pal.selFg : pal.dot,
              fontWeight: it.selected ? 700 : 600,
              cursor: "pointer",
            }}
          >
            {String(it.year)}
          </button>
        ) : (
          // No border, because the border is what says "selectable".
          <span
            key={`lbl-${it.year}`}
            style={{
              ...labelBase,
              left: it.x,
              top: it.boxY,
              border: "1px solid transparent",
              background: "transparent",
              color: pal.axis,
              fontWeight: 400,
            }}
          >
            {String(it.year)}
          </span>
        ),
      )}
    </div>
  );
}
