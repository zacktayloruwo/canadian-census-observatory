// src/FaIcon.jsx
//
// Renders a FontAwesome icon from its raw icon data as inline SVG.
//
// The React binding (@fortawesome/react-fontawesome) is deliberately not a
// dependency of this project — the map's Leaflet controls build their glyphs
// with the DOM API instead (see faSvg in ChoroplethMap). This is the JSX
// equivalent for the same icon data, so both paths draw from one source.

import React from "react";

export default function FaIcon({ icon, size = 16, title, style }) {
  if (!icon || !icon.icon) return null;
  const [w, h, , , pathData] = icon.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={size}
      height={size}
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : "true"}
      style={{ display: "block", ...style }}
    >
      {title && <title>{title}</title>}
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
