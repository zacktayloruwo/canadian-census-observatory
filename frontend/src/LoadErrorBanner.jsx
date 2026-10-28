// LoadErrorBanner.jsx
//
// "Some data couldn't be loaded" bar at the top of the map, shown while the
// last burst of data requests had a failure (see pendingRequests.js). Without
// it a failed fetch only reached the console, and the map kept showing the
// previous year or variable while the selectors showed the new one. Retry
// reloads the page: the whole view lives in the URL, so it comes back as it was.

import { useSyncExternalStore } from "react";
import { Button, useMantineColorScheme } from "@mantine/core";
import { pendingRequests } from "./pendingRequests";

export default function LoadErrorBanner() {
  const failure = useSyncExternalStore(pendingRequests.subscribe, pendingRequests.getFailure);
  const { colorScheme } = useMantineColorScheme();
  if (!failure) return null;
  const isDark = colorScheme === "dark";

  return (
    <div
      role="alert"
      style={{
        // Centred by margin, not left:50% + translate: an absolute box at
        // left:50% can only use the right half of a narrow map before wrapping.
        position: "absolute",
        top: 12,
        left: 0,
        right: 0,
        margin: "0 auto",
        width: "fit-content",
        zIndex: 1001,
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: "calc(100% - 32px)",
        padding: "6px 8px 6px 12px",
        borderRadius: 6,
        border: `1px solid ${isDark ? "#7a3b3b" : "#e0b4b4"}`,
        background: isDark ? "#3a1f1f" : "#fff4f4",
        color: isDark ? "#f3d6d6" : "#7a1f1f",
        fontSize: 13,
        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
      }}
    >
      <span>
        Some data couldn&rsquo;t be loaded ({failure.message}). The map or plots may be out of date.
      </span>
      <Button size="compact-xs" variant="light" color="red" onClick={() => window.location.reload()}>
        Retry
      </Button>
    </div>
  );
}
