// src/HelpOverlay.jsx
//
// A sequential "coach mark" walkthrough triggered from the header's info
// icon. Presentational only: receives `steps` (each with a ref to an
// already-rendered DOM node) and `onClose`, and does all measurement and
// positioning itself via getBoundingClientRect(). One step is highlighted at
// a time — a huge box-shadow spread on the highlight box dims the rest of
// the viewport without needing a separate backdrop element or an SVG mask.
import React, { useEffect, useState } from "react";
import { ActionIcon, Text, Button, useMantineColorScheme } from "@mantine/core";
import { IconX } from "@tabler/icons-react";

const CALLOUT_WIDTH = 280;
const GAP = 12;

export default function HelpOverlay({ steps, onClose }) {
  const { colorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";

  const [stepIndex, setStepIndex] = useState(0);

  // Only steps whose target is actually mounted right now (e.g. the legend
  // may be absent if no data has loaded yet).
  const visibleSteps = steps.filter((s) => s.ref.current);
  const step = visibleSteps[stepIndex] ?? null;
  // Measured directly during render (not via effect + state): the target is
  // already-committed DOM from a prior render, so this read is safe and
  // avoids an extra render pass just to store a rect in state.
  const rect = step ? step.ref.current.getBoundingClientRect() : null;

  // Dismiss on Escape; close (rather than reposition) on resize to avoid
  // stale-rect bugs — this app has no scrollable page area to track.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    function onResize() {
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  if (!step || !rect) return null;

  const pad = 6;
  const highlightRect = {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };

  // Prefer placing the callout below the target; flip above if it would
  // overflow the viewport bottom.
  const calloutHeight = 150; // rough estimate, enough for the overflow check
  const placeBelow = highlightRect.top + highlightRect.height + GAP + calloutHeight <= window.innerHeight;
  const calloutTop = placeBelow
    ? highlightRect.top + highlightRect.height + GAP
    : Math.max(GAP, highlightRect.top - calloutHeight - GAP);
  const calloutLeft = Math.min(
    Math.max(GAP, highlightRect.left),
    window.innerWidth - CALLOUT_WIDTH - GAP,
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }} onClick={onClose}>
      {/* Highlight box — its own box-shadow dims the rest of the viewport,
          so no separate backdrop element is needed. */}
      <div
        style={{
          position: "fixed",
          left: highlightRect.left,
          top: highlightRect.top,
          width: highlightRect.width,
          height: highlightRect.height,
          border: "2px solid var(--mantine-color-blue-5)",
          borderRadius: 6,
          boxShadow: `0 0 0 9999px ${isDark ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.45)"}`,
          pointerEvents: "none",
        }}
      />

      {/* Callout */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: calloutLeft,
          top: calloutTop,
          width: CALLOUT_WIDTH,
          background: isDark ? "rgba(30,30,30,0.97)" : "rgba(255,255,255,0.97)",
          color: isDark ? "#e8e8e8" : "#222",
          border: `1px solid ${isDark ? "#555" : "#ccc"}`,
          borderRadius: 8,
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          padding: "10px 12px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <Text size="sm" fw={600}>{step.title}</Text>
          <ActionIcon size="sm" variant="subtle" onClick={onClose} title="Close guide">
            <IconX size={14} />
          </ActionIcon>
        </div>
        <Text size="xs" mt={4}>{step.text}</Text>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <Text size="xs" c="dimmed">{stepIndex + 1} / {visibleSteps.length}</Text>
          <div style={{ display: "flex", gap: 6 }}>
            {stepIndex > 0 && (
              <Button size="xs" variant="subtle" onClick={() => setStepIndex((i) => i - 1)}>Back</Button>
            )}
            {stepIndex < visibleSteps.length - 1 ? (
              <Button size="xs" onClick={() => setStepIndex((i) => i + 1)}>Next</Button>
            ) : (
              <Button size="xs" onClick={onClose}>Done</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
