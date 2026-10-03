// src/PlotsTray.jsx
//
// The plots panel, docked down the right-hand side of the map with the two
// plots stacked.
//
// It is a real flex sibling of the map rather than an overlay, so opening it
// narrows the map instead of covering it — App feeds its state into
// ChoroplethMap's layoutKey, which invalidates the Leaflet size once the
// layout settles.
//
// A header line carries the reading — which place, what value, which variable
// and year — so it stays legible however short the plots are squeezed.

import React, { forwardRef, useState } from "react";
import { ActionIcon, Text } from "@mantine/core";
import { faCircleChevronRight } from "@fortawesome/free-solid-svg-icons";
import FaIcon from "./FaIcon";
import { seriesColors } from "./config";

export const RAIL_MIN_WIDTH = 260;
export const RAIL_MAX_WIDTH = 560;
export const RAIL_DEFAULT_WIDTH = 340;
// Below this the ECharts axes stop being readable and the section scrolls
// instead of shrinking further.
const SECTION_MIN_HEIGHT = 200;

// Grab strip down the rail's left edge. Mirrors the sidebar's ResizeHandle:
// drag to resize, click without dragging to collapse.
function RailResizeHandle({ width, min, max, onResize, onCollapse }) {
  const [hovered, setHovered] = useState(false);

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let moved = false;

    function onMove(ev) {
      // Dragging left grows the rail, so the delta is inverted.
      const delta = startX - ev.clientX;
      if (Math.abs(delta) > 3) moved = true;
      onResize(Math.max(min, Math.min(max, startW + delta)));
    }
    function onUp() {
      if (!moved) onCollapse();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Drag to resize · Click to collapse"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 6,
        cursor: "col-resize",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 3,
          height: 28,
          borderRadius: 2,
          background: hovered ? "var(--mantine-color-blue-6)" : "var(--mantine-color-gray-6)",
          opacity: hovered ? 1 : 0.75,
          transition: "background 0.15s, opacity 0.15s",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

// One geography: swatch, then its name in its series colour.
function GeoRow({ color, name }) {
  if (!name) return null;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: 2,
          background: color,
          flexShrink: 0,
          transform: "translateY(1px)",
        }}
      />
      <Text size="sm" fw={600} style={{ color, flex: 1, minWidth: 0, lineHeight: 1.3 }}>
        {name}
      </Text>
    </div>
  );
}

const PlotsTray = forwardRef(function PlotsTray(
  {
    onToggle,
    width = RAIL_DEFAULT_WIDTH,
    onResize,
    colorScheme,
    themeLabel,
    variableLabel,
    focalLabel,
    refLabel,
    hasFocal = true,
    hasRef,
    profile,
    overTime,
  },
  forwardedRef,
) {
  const isDark = colorScheme === "dark";
  const series = seriesColors(colorScheme);
  const border = isDark ? "#373a40" : "#dee2e6";
  const panel = isDark ? "#1a1b1e" : "#ffffff";

  return (
    <div
      ref={forwardedRef}
      style={{
        position: "relative",
        width,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: panel,
        borderLeft: `1px solid ${border}`,
      }}
    >
      <RailResizeHandle
        width={width}
        min={RAIL_MIN_WIDTH}
        max={RAIL_MAX_WIDTH}
        onResize={onResize}
        onCollapse={onToggle}
      />

      {/* Header — what is being shown, then who it is being shown for: theme
          and variable once at the top, then one row per geography in its own
          series colour. The plots below title themselves only with the year
          and "Change over time", since the subject is stated here. */}
      <div
        style={{
          flexShrink: 0,
          padding: "8px 10px 8px 16px",
          borderBottom: `1px solid ${border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {themeLabel && (
              <Text size="sm" fw={700} style={{ lineHeight: 1.3 }}>{themeLabel}</Text>
            )}
            {variableLabel && (
              <Text size="sm" style={{ lineHeight: 1.3 }}>{variableLabel}</Text>
            )}
          </div>
          <ActionIcon variant="subtle" size="sm" onClick={onToggle} title="Collapse plots" style={{ flexShrink: 0, color: "var(--mantine-color-blue-6)" }}>
            <FaIcon icon={faCircleChevronRight} size={16} />
          </ActionIcon>
        </div>

        <div style={{ marginTop: 6 }}>
          {hasFocal && <GeoRow color={series.focal} name={focalLabel} />}
          {hasRef && <GeoRow color={series.ref} name={refLabel} />}
          {!hasFocal && !hasRef && (
            <Text size="xs" c="dimmed">No geography selected</Text>
          )}
        </div>
      </div>

      {/* Body — the two plots stacked, splitting the remaining height evenly.
          flex:1 1 0 on both sections (rather than letting them size to their
          content) is what makes the charts grow with the window: each plot's
          root is height:100% over a ResizeObserver, so they follow. The
          minHeight floor still applies, and the body scrolls when the rail is
          too short to honour it — a squashed axis is worse than a scrollbar. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        <div style={{ flex: "1 1 0", minHeight: SECTION_MIN_HEIGHT, padding: "10px 10px 10px 16px", boxSizing: "border-box" }}>
          {profile}
        </div>
        <div style={{ height: 1, background: border, flexShrink: 0 }} />
        <div style={{ flex: "1 1 0", minHeight: SECTION_MIN_HEIGHT, padding: "10px 10px 10px 16px", boxSizing: "border-box" }}>
          {overTime}
        </div>
      </div>
    </div>
  );
});

export default PlotsTray;
