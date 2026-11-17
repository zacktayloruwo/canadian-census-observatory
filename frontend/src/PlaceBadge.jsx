// src/PlaceBadge.jsx
// The two selected geographies are numbered wherever they are named: a circle
// in the geography's series colour with a white 1 (the geography) or 2 (the
// second geography). PlaceBadge draws it in React; placeBadgeRich
// (placeBadgeRich.js) gives ECharts the same mark as a rich-text style.

export function PlaceBadge({ n, color, size = 16 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "#ffffff",
        fontSize: Math.round(size * 0.62),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {n}
    </span>
  );
}
