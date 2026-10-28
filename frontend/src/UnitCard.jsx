// UnitCard.jsx
//
// The unit view (docs/UNIT-LINEAGE-VIEW.md): a card inset over the map and
// plots -- the header bar and the selector panel stay usable -- showing one
// geography across time:
//   - a branching timeline (LineageTimeline): one column per census, the
//     unit's own lineage as the coloured track, every lineage that merged
//     into it (above) or split from it (below) as a grey track, joined by
//     dashed links; each grey track is labelled with the share of its
//     area that overlaps this unit. A click on a
//     census of the own track takes the app to that year; a click on a
//     neighbouring track opens that lineage (primary geography only).
//   - the names it carried, the boundary changes as sentences (the text
//     equivalent of the diagram), and the province, CD and CMA per year.
// Data: /api/unit. Keyboard: focus moves into the card and is trapped there;
// Esc closes it and focus returns to the button that opened it.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FocusTrap, Text, Title, Table, Loader, Group, CloseButton, Paper } from "@mantine/core";
import { API_BASE, apiFetch } from "./data/edition";

const LEVEL_NAME = { 1: "Census tract", 2: "Census subdivision", 3: "Census division", 4: "Metropolitan area", 5: "Province / territory" };

const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);
const spanOf = (o) => (o?.first_year == null ? "" : o.first_year === o.last_year ? `${o.first_year}` : `${o.first_year}–${o.last_year}`);

// One plain sentence per event, told from this unit's side.
function describe(e) {
  const o = e.other ? `${e.other.geoname ?? e.other.geosid} (${spanOf(e.other)})` : "";
  const of = (share) => (share != null ? `, ${pct(share)} of its area` : "");
  switch (e.event) {
    case "amalgamate":
      return e.direction === "in" ? `${o} merged into it${of(e.share_from)}.` : `Merged into ${o}.`;
    case "absorbed":
      return e.direction === "in" ? `Absorbed ${o}${of(e.share_from)}.` : `Absorbed into ${o}.`;
    case "split":
      return e.direction === "in" ? `Formed from part of ${o}.` : `${o} was split off from it.`;
    case "redraw":
      return e.direction === "self" ? "Boundaries redrawn." : e.direction === "in" ? `Redrawn from ${o}.` : `Redrawn as ${o}.`;
    case "rename":
      return e.direction === "self" ? "Renamed (same territory)." : `Renamed: ${o}.`;
    case "continue":
      return e.note ? `Boundary change: ${e.note.replace(/^annex: /, "annexed ").trim()}.` : "Continues.";
    default:
      return `${e.event}${o ? ` (${o})` : ""}.`;
  }
}

// ── Branching timeline ───────────────────────────────────────────────────────
// Census columns: decennial 1851-1951, then 1961, 1971, 1976 and five-yearly
// from 1981; 1956 and 1966 only when a unit has them (no CSD/CD tables).
const BASE_YEARS = [1851, 1861, 1871, 1881, 1891, 1901, 1911, 1921, 1931, 1941, 1951,
                    1961, 1971, 1976, 1981, 1986, 1991, 1996, 2001, 2006, 2011, 2016, 2021];
const COL_W = 66, ROW_H = 36, PAD_X = 20, TOP = 26, MAX_PER_TRANSITION = 6;

function layout(unit) {
  // One neighbour per lineage, from the events that link it to this one;
  // at most MAX_PER_TRANSITION per transition and side are drawn.
  const byGeouid = new Map();
  const perTransition = new Map();
  let hidden = 0;
  for (const e of unit.events) {
    if (!e.other || e.direction === "self") continue;
    const t = `${e.time_from}|${e.time_to}|${e.direction}`;
    const n = perTransition.get(t) ?? 0;
    if (!byGeouid.has(e.other.geouid) && n >= MAX_PER_TRANSITION) { hidden++; continue; }
    perTransition.set(t, n + 1);
    if (!byGeouid.has(e.other.geouid)) {
      byGeouid.set(e.other.geouid, { ...e.other, side: e.direction === "in" ? "above" : "below", links: [] });
    }
    byGeouid.get(e.other.geouid).links.push(e);
  }
  const neighbours = [...byGeouid.values()];

  const memberYears = unit.members.map((m) => Number(m.time));
  const lo = Math.min(...memberYears, ...neighbours.map((n) => n.first_year ?? Infinity));
  const hi = Math.max(...memberYears, ...neighbours.map((n) => n.last_year ?? -Infinity));
  const years = [...new Set([...BASE_YEARS, ...memberYears])].filter((y) => y >= lo && y <= hi).sort((a, b) => a - b);
  const xOf = (y) => {
    let i = years.indexOf(y);
    if (i < 0) i = years.findIndex((t) => t > y) - 0.5;   // a year between columns
    return PAD_X + i * COL_W + COL_W / 2;
  };

  // Greedy row packing per side: a track takes the first row it fits in.
  for (const side of ["above", "below"]) {
    const rows = [];
    for (const n of neighbours.filter((n) => n.side === side).sort((a, b) => a.first_year - b.first_year || a.last_year - b.last_year)) {
      let r = rows.findIndex((end) => end < n.first_year);
      if (r < 0) { r = rows.length; rows.push(0); }
      rows[r] = n.last_year;
      n.row = side === "above" ? -(r + 1) : r + 1;
    }
  }
  const above = Math.max(0, ...neighbours.filter((n) => n.row < 0).map((n) => -n.row));
  const below = Math.max(0, ...neighbours.filter((n) => n.row > 0).map((n) => n.row));
  const yOf = (row) => TOP + (row + above) * ROW_H + ROW_H / 2;
  return { years, xOf, yOf, neighbours, hidden,
           width: PAD_X * 2 + years.length * COL_W, height: TOP + (above + below + 1) * ROW_H + 18 };
}

function LineageTimeline({ unit, year, accent, onJumpYear, onOpenNeighbour }) {
  const L = layout(unit);
  const scrollRef = useRef(null);
  const yMain = L.yOf(0);
  const xCurrent = L.xOf(Number(year));

  // Open with the current year in view.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, xCurrent - el.clientWidth / 2);
  }, [xCurrent]);

  const first = Number(unit.members[0]?.time), last = Number(unit.members.at(-1)?.time);
  const nameChanges = unit.names.slice(1);
  const onKey = (fn) => (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fn(); } };

  return (
    <div>
      <div ref={scrollRef} style={{ overflowX: "auto", border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
        <svg width={L.width} height={L.height} role="group"
             aria-label={`Timeline of ${unit.names.at(-1)?.name ?? "this unit"}: ${unit.members.length} censuses, ${L.neighbours.length} linked lineages`}
             style={{ display: "block", fontFamily: "inherit" }}>
          {/* census columns */}
          {L.years.map((y) => (
            <g key={y}>
              <line x1={L.xOf(y)} x2={L.xOf(y)} y1={TOP - 4} y2={L.height - 6} stroke="var(--mantine-color-default-border)" strokeWidth={1} />
              <text x={L.xOf(y)} y={14} textAnchor="middle" fontSize={11}
                    fill={y === Number(year) ? accent : "var(--mantine-color-dimmed)"} fontWeight={y === Number(year) ? 700 : 400}>{y}</text>
            </g>
          ))}

          {/* links: dashed, from the earlier unit to the later one */}
          {L.neighbours.flatMap((n) => n.links.map((e, i) => {
            const fromY = e.direction === "in" ? L.yOf(n.row) : yMain, toY = e.direction === "in" ? yMain : L.yOf(n.row);
            const x1 = L.xOf(e.time_from), x2 = L.xOf(e.time_to), mx = (x1 + x2) / 2;
            return (
              <path key={`${n.geouid}-${i}`} d={`M${x1},${fromY} C${mx},${fromY} ${mx},${toY} ${x2},${toY}`} fill="none"
                    stroke={accent} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="4 3" />
            );
          }))}

          {/* neighbouring lineages */}
          {L.neighbours.map((n) => {
            const x1 = L.xOf(n.first_year) - 8, x2 = L.xOf(n.last_year) + 8, y = L.yOf(n.row);
            const label = `${n.geoname ?? n.geosid} (${spanOf(n)})`;
            // The label sits at the end that meets this place -- the right end
            // for a place that merged in, the left end for one split off --
            // with the share of its area that moved.
            const e0 = n.links[0];
            const share = e0 ? (n.side === "above" ? e0.share_from : e0.share_to) : null;
            const shown = `${label.length > 34 ? `${label.slice(0, 33)}…` : label}${share != null ? ` · ${pct(share)}` : ""}`;
            const open = onOpenNeighbour ? () => onOpenNeighbour(n) : null;
            return (
              <g key={n.geouid} role={open ? "button" : undefined} tabIndex={open ? 0 : undefined}
                 aria-label={open ? `Open the timeline of ${label}` : label}
                 onClick={open ?? undefined} onKeyDown={open ? onKey(open) : undefined}
                 style={{ cursor: open ? "pointer" : "default" }}>
                <title>{label}{open ? " — open its timeline" : ""}</title>
                <rect x={x1} y={y - 5} width={Math.max(10, x2 - x1)} height={10} rx={5}
                      fill="var(--mantine-color-gray-5)" fillOpacity={0.6} />
                <text x={n.side === "above" ? x2 - 2 : x1 + 2} y={y - 9} fontSize={11}
                      textAnchor={n.side === "above" ? "end" : "start"} fill="var(--mantine-color-text)">
                  {shown}
                </text>
              </g>
            );
          })}

          {/* the unit's own lineage */}
          <rect x={L.xOf(first) - 9} y={yMain - 6} width={L.xOf(last) - L.xOf(first) + 18} height={12} rx={6} fill={accent} />
          {/* each new name, just above the track, cut to fit before the next one */}
          {nameChanges.map((n, i) => {
            const room = (nameChanges[i + 1] ? L.xOf(nameChanges[i + 1].from) : L.xOf(last) + COL_W) - L.xOf(n.from);
            const max = Math.max(4, Math.floor(room / 5.8));
            return (
              <text key={n.from} x={L.xOf(n.from) - 4} y={yMain - 11} fontSize={10} fill="var(--mantine-color-text)">
                <title>{n.name}</title>
                {n.name.length > max ? `${n.name.slice(0, max - 1)}…` : n.name}
              </text>
            );
          })}
          {unit.members.map((m) => {
            const t = Number(m.time), isCurrent = t === Number(year);
            const go = m.has_data && !isCurrent ? () => onJumpYear(t) : null;
            return (
              <g key={t} role={go ? "button" : undefined} tabIndex={go ? 0 : undefined}
                 aria-label={`${t}: ${m.geoname ?? m.geosid}${isCurrent ? " (shown)" : m.has_data ? " — show this year" : " — no data"}`}
                 onClick={go ?? undefined} onKeyDown={go ? onKey(go) : undefined}
                 style={{ cursor: go ? "pointer" : "default" }}>
                <title>{`${t}: ${m.geoname ?? m.geosid} (${m.geosid})`}</title>
                <circle cx={L.xOf(t)} cy={yMain} r={isCurrent ? 8 : 6}
                        fill={isCurrent ? "var(--mantine-color-body)" : m.has_data ? "#fff" : accent}
                        stroke={isCurrent ? accent : "#fff"} strokeWidth={isCurrent ? 4 : 1.5} />
              </g>
            );
          })}
        </svg>
      </div>
      <Text size="xs" c="dimmed" mt={6}>
        The coloured track is this place; grey tracks are places that merged into it (above) or that it split into or
        merged into (below), joined by dashed links. The percentage is how much of that place&apos;s area overlaps this one. Select a census on the coloured track to show that year
        {onOpenNeighbour ? ", or a grey track to open that place's timeline" : ""}.
        {L.hidden ? ` ${L.hidden} further linked place${L.hidden === 1 ? " is" : "s are"} listed below but not drawn.` : ""}
      </Text>
    </div>
  );
}

// ── The card ─────────────────────────────────────────────────────────────────
export default function UnitCard({ opened, onClose, geosid, year, level, accent, onJumpYear, onOpenNeighbour }) {
  // The answer is kept with the request it belongs to; while it is for an
  // older request (or none), the card shows "loading".
  const key = opened && geosid && year ? `${geosid}|${year}|${level ?? ""}` : null;
  const [result, setResult] = useState({ key: null, status: "idle", unit: null });

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const url = `${API_BASE}/api/unit?geosid=${encodeURIComponent(geosid)}&year=${year}${level ? `&level=${level}` : ""}`;
    apiFetch(url, { signal: controller.signal })
      .then(async (r) => {
        if (r.status === 404) return setResult({ key, status: "missing", unit: null });
        if (!r.ok) return setResult({ key, status: "error", unit: null });
        setResult({ key, status: "ok", unit: await r.json() });
      })
      .catch((err) => { if (err.name !== "AbortError") setResult({ key, status: "error", unit: null }); });
    return () => controller.abort();
  }, [key, geosid, year, level]);

  // Focus return: back to whatever had focus when the card opened.
  useEffect(() => {
    if (!opened) return;
    const returnTo = document.activeElement;
    return () => { if (returnTo?.focus && document.contains(returnTo)) returnTo.focus(); };
  }, [opened]);

  // The card fills the map area; where that is too narrow to read (a small
  // window, the map squeezed by side columns) it fills the window below the
  // header bar instead. A probe the size of the map area measures it.
  const probeRef = useRef(null);
  const [cramped, setCramped] = useState(false);
  useEffect(() => {
    const el = probeRef.current;
    if (!opened || !el) return;
    const ro = new ResizeObserver(([entry]) => setCramped(entry.contentRect.width < 480));
    ro.observe(el);
    return () => ro.disconnect();
  }, [opened]);

  if (!opened) return null;
  const status = !key ? "idle" : result.key === key ? result.status : "loading";
  const unit = status === "ok" ? result.unit : null;
  const current = unit?.members?.find((m) => Number(m.time) === Number(year));
  const name = current?.geoname ?? unit?.names?.at(-1)?.name ?? geosid;
  const transitions = [];
  for (const e of unit?.events ?? []) {
    const k = `${e.time_from}→${e.time_to}`;
    let t = transitions.find((x) => x.key === k);
    if (!t) transitions.push((t = { key: k, from: e.time_from, to: e.time_to, items: [] }));
    t.items.push(e);
  }

  return (
    <>
    <div ref={probeRef} aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", visibility: "hidden" }} />
    <FocusTrap active>
      <Paper
        role="dialog"
        aria-labelledby="unit-card-title"
        shadow="xl"
        radius="md"
        withBorder
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        style={{
          ...(cramped
            ? { position: "fixed", top: "calc(var(--app-shell-header-height, 48px) + 8px)", left: 8, right: 8, bottom: 8 }
            : { position: "absolute", inset: 4 }),   // inside the legend (10px in), so it is covered
          zIndex: 1100,
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--mantine-color-body)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px",
                      borderBottom: "1px solid var(--mantine-color-default-border)", borderTop: "4px solid var(--mantine-primary-color-filled)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Title id="unit-card-title" order={3} style={{ lineHeight: 1.2 }}>{name}</Title>
            <Text size="sm" c="dimmed">
              {LEVEL_NAME[unit?.level] ?? ""}
              {unit ? ` · ${spanOf(unit)} · ${unit.members.length} census${unit.members.length === 1 ? "" : "es"}` : ""}
              {unit?.geouid ? ` · lineage ${unit.geouid}` : ""}
            </Text>
          </div>
          <CloseButton aria-label="Close the timeline" onClick={onClose} data-autofocus />
        </div>

        <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
          {status === "loading" && <Group gap={8}><Loader size={14} /><Text size="sm">Loading…</Text></Group>}
          {status === "missing" && <Text size="sm">This unit does not exist in {year}.</Text>}
          {status === "error" && <Text size="sm" c="red">The unit&rsquo;s history couldn&rsquo;t be loaded.</Text>}

          {status === "ok" && unit && (
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <section aria-labelledby="unit-tl">
                <Text id="unit-tl" fw={600} mb={6}>Timeline</Text>
                <LineageTimeline unit={unit} year={year} accent={accent} onJumpYear={onJumpYear}
                                 onOpenNeighbour={onOpenNeighbour ? (n) => onOpenNeighbour(n, unit.level) : null} />
                {!unit.geouid && (
                  <Text size="xs" c="dimmed" mt={4}>
                    No lineage linkage at this level: the years are those in which this code names the same unit.
                  </Text>
                )}
              </section>

              <section aria-labelledby="unit-names">
                <Text id="unit-names" fw={600} mb={4}>Names carried</Text>
                <Text size="sm">
                  {unit.names.map((n, i) => (
                    <span key={i}>{i ? "; " : ""}{n.name} ({n.from === n.to ? n.from : `${n.from}–${n.to}`})</span>
                  ))}
                </Text>
              </section>

              <section aria-labelledby="unit-events">
                <Text id="unit-events" fw={600} mb={4}>Boundary changes</Text>
                {!transitions.length ? (
                  <Text size="sm" c="dimmed">
                    {unit.geouid ? "None recorded: the unit kept its territory between the censuses shown." : "Not tracked at this level."}
                  </Text>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {transitions.map((t) => (
                      <li key={t.key} style={{ marginBottom: 8 }}>
                        <Text size="sm" fw={600}>{t.from} → {t.to}</Text>
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {t.items.map((e, i) => <li key={i}><Text size="sm">{describe(e)}</Text></li>)}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section aria-labelledby="unit-hier">
                <Text id="unit-hier" fw={600} mb={4}>Where it sat</Text>
                <Table striped withTableBorder fz="sm" style={{ maxWidth: 760 }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Year</Table.Th><Table.Th>Code</Table.Th><Table.Th>Province / territory</Table.Th>
                      {unit.level === 2 && <Table.Th>Census division</Table.Th>}
                      {(unit.level === 1 || unit.level === 2) && <Table.Th>Metropolitan area</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {unit.hierarchy.map((h, i) => {
                      const prev = unit.hierarchy[i - 1];
                      const moved = prev && (prev.pr?.geosid !== h.pr?.geosid || prev.cd?.geouid !== h.cd?.geouid);
                      return (
                        <Table.Tr key={h.time} style={moved ? { fontWeight: 600 } : undefined}>
                          <Table.Td>{h.time}</Table.Td>
                          <Table.Td style={{ fontVariantNumeric: "tabular-nums" }}>{unit.members[i]?.geosid}</Table.Td>
                          <Table.Td>{h.pr?.name ?? "—"}</Table.Td>
                          {unit.level === 2 && <Table.Td>{h.cd ? `${h.cd.name} (${h.cd.geosid})` : "—"}</Table.Td>}
                          {(unit.level === 1 || unit.level === 2) && <Table.Td>{h.cma?.name ?? "—"}</Table.Td>}
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
                <Text size="xs" c="dimmed" mt={4}>Bold rows: the enclosing province or census division changed.</Text>
              </section>

              <Text size="xs" c="dimmed">
                A lineage links the same place across censuses by its name and the overlap of its boundaries. A place
                keeps its lineage through renames and small boundary changes; an amalgamation or split starts a new one.
              </Text>
            </div>
          )}
        </div>
      </Paper>
    </FocusTrap>
    </>
  );
}
