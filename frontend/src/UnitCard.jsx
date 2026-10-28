// UnitCard.jsx
//
// The unit view (docs/UNIT-LINEAGE-VIEW.md, phase 3): a full-screen card for
// one geography showing what it is across time -- the names it carried, the
// census years it exists in (click one to take the app there), what happened
// at each boundary change (splits, amalgamations, renames, annexations), and
// the province, CD and CMA it sat in each year. Data: /api/unit.
//
// Mantine's Modal gives the dialog role, the focus trap, Esc to close and
// focus return to the button that opened it.

import React, { useEffect, useState } from "react";
import { Modal, Text, Title, Table, Loader, Group, UnstyledButton } from "@mantine/core";
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

export default function UnitCard({ opened, onClose, geosid, year, level, accent, onJumpYear }) {
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

  const status = !key ? "idle" : result.key === key ? result.status : "loading";
  const unit = status === "ok" ? result.unit : null;

  const current = unit?.members?.find((m) => Number(m.time) === Number(year));
  const name = current?.geoname ?? unit?.names?.at(-1)?.name ?? geosid;
  const transitions = [];
  for (const e of unit?.events ?? []) {
    const key = `${e.time_from}→${e.time_to}`;
    let t = transitions.find((x) => x.key === key);
    if (!t) transitions.push((t = { key, from: e.time_from, to: e.time_to, items: [] }));
    t.items.push(e);
  }
  const eventYears = new Set(transitions.map((t) => t.to));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      zIndex={1100}
      title={
        <div>
          <Title order={3} style={{ lineHeight: 1.2 }}>{name}</Title>
          <Text size="sm" c="dimmed">
            {LEVEL_NAME[unit?.level] ?? ""}
            {unit ? ` · ${spanOf(unit)} · ${unit.members.length} census${unit.members.length === 1 ? "" : "es"}` : ""}
            {unit?.geouid ? ` · lineage ${unit.geouid}` : ""}
          </Text>
        </div>
      }
    >
      {status === "loading" && <Group gap={8}><Loader size={14} /><Text size="sm">Loading…</Text></Group>}
      {status === "missing" && <Text size="sm">This unit does not exist in {year}.</Text>}
      {status === "error" && <Text size="sm" c="red">The unit&rsquo;s history couldn&rsquo;t be loaded.</Text>}

      {status === "ok" && unit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1100 }}>
          {/* Names carried */}
          <section aria-labelledby="unit-names">
            <Text id="unit-names" fw={600} mb={4}>Names carried</Text>
            <Text size="sm">
              {unit.names.map((n, i) => (
                <span key={i}>{i ? "; " : ""}{n.name} ({n.from === n.to ? n.from : `${n.from}–${n.to}`})</span>
              ))}
            </Text>
            {!unit.geouid && (
              <Text size="xs" c="dimmed" mt={4}>
                No lineage linkage at this level: the years are those in which this code names the same unit.
              </Text>
            )}
          </section>

          {/* Census years: one button per census the unit exists in */}
          <section aria-labelledby="unit-years">
            <Text id="unit-years" fw={600} mb={4}>Census years</Text>
            <Text size="xs" c="dimmed" mb={8}>
              Select a year to show it on the map. Dimmed years have neither data nor boundaries; a dot marks a boundary change.
            </Text>
            <div role="list" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {unit.members.map((m) => {
                const isCurrent = Number(m.time) === Number(year);
                return (
                  <div role="listitem" key={m.time}>
                    <UnstyledButton
                      onClick={() => onJumpYear(Number(m.time))}
                      disabled={!m.has_data || isCurrent}
                      aria-current={isCurrent ? "true" : undefined}
                      aria-label={`${m.time}: ${m.geoname ?? m.geosid}${eventYears.has(Number(m.time)) ? ", boundary change" : ""}${m.has_data ? "" : ", no data"}`}
                      title={`${m.geoname ?? m.geosid} (${m.geosid})`}
                      style={{
                        position: "relative",
                        padding: "4px 10px",
                        borderRadius: 6,
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                        border: `1px solid ${isCurrent ? accent : "var(--mantine-color-default-border)"}`,
                        background: isCurrent ? accent : "transparent",
                        color: isCurrent ? "#fff" : m.has_data ? undefined : "var(--mantine-color-dimmed)",
                        cursor: m.has_data && !isCurrent ? "pointer" : "default",
                      }}
                    >
                      {m.time}
                      {eventYears.has(Number(m.time)) && (
                        <span aria-hidden="true" style={{ position: "absolute", top: -3, right: -3, width: 7, height: 7, borderRadius: 4, background: isCurrent ? "#fff" : accent }} />
                      )}
                    </UnstyledButton>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Boundary changes */}
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
                      {t.items.map((e, i) => (
                        <li key={i}>
                          <Text size="sm">{describe(e)}</Text>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Enclosing units */}
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
                  const m = unit.members[i];
                  return (
                    <Table.Tr key={h.time} style={moved ? { fontWeight: 600 } : undefined}>
                      <Table.Td>{h.time}</Table.Td>
                      <Table.Td style={{ fontVariantNumeric: "tabular-nums" }}>{m?.geosid}</Table.Td>
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
    </Modal>
  );
}
