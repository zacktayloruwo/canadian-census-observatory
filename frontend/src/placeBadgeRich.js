// src/placeBadgeRich.js
// PlaceBadge (PlaceBadge.jsx) as an ECharts rich-text style: a label's
// `{n|1}` draws the numbered circle in the geography's series colour.

export const placeBadgeRich = (color, size = 14) => ({
  backgroundColor: color,
  borderRadius: size / 2,
  width: size,
  height: size,
  lineHeight: size,
  align: "center",
  color: "#ffffff",
  fontSize: Math.round(size * 0.64),
  fontWeight: "bold",
});
