// DataLoadingIndicator.jsx
//
// "Loading…" pill shown in the centre of the map while data requests are in flight —
// the first queries after start-up wait on DuckDB-WASM opening the Parquet
// files over the network, which can take seconds. Appears only once requests
// have been pending for a moment (see pendingRequests in data/apiFetch.js),
// so quick queries don't flicker.

import { useSyncExternalStore } from "react";
import { Loader, useMantineColorScheme } from "@mantine/core";
import { pendingRequests } from "./data/apiFetch";

export default function DataLoadingIndicator() {
  const visible = useSyncExternalStore(pendingRequests.subscribe, pendingRequests.isSlow);
  const { colorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 1000,
        pointerEvents: "none",
        display: visible ? "flex" : "none",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${isDark ? "#555" : "#ddd"}`,
        background: isDark ? "#1e1e1e" : "#ffffff",
        color: isDark ? "#e8e8e8" : "#222",
        fontSize: 13,
        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
      }}
    >
      <Loader size={14} color={isDark ? "#e8e8e8" : "#222"} />
      {visible ? "Loading…" : null}
    </div>
  );
}
