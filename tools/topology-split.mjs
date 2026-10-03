// tools/topology-split.mjs
//
// Split a census year's TopoJSON bundle so the fine levels load by area:
//   base                  every object not split below (pr, cma), with only
//                         the arcs it uses
//   parts.ct[<cmauid>]    census tracts, one topology per CMA
//   parts.csd[<pruid>]    census subdivisions, one topology per province
//   parts.cd[<pruid>]     census divisions, one topology per province
// Part keys come from the ids: a tract id starts with its CMA code
// (5350001.00 → 535), CSD and CD ids with the province code (3506008 → 35,
// 3506 → 35). An id with no such prefix (the disputed-territory polygon
// "DISP" in 1881, 1911 and 1921) is a part of its own. Arcs are copied as-is
// (still quantized, delta-encoded under the same transform), so geometry is
// byte-for-byte what the original bundle decodes to.

/** Part key of a feature id at a split level. */
export const PART_OF = {
  ct: (id) => String(id).slice(0, 3),
  csd: (id) => (/^\d{2}/.test(String(id)) ? String(id).slice(0, 2) : String(id)),
  cd: (id) => (/^\d{2}/.test(String(id)) ? String(id).slice(0, 2) : String(id)),
};

/** Topology with only `objects`, keeping just the arcs they reference. */
export function subsetTopology(topo, objects) {
  const remap = new Map(); // old arc index → new
  const arcs = [];
  const mapArc = (i) => {
    const k = i < 0 ? ~i : i;
    if (!remap.has(k)) { remap.set(k, arcs.length); arcs.push(topo.arcs[k]); }
    const j = remap.get(k);
    return i < 0 ? ~j : j;
  };
  const walk = (a) => (typeof a[0] === "number" ? a.map(mapArc) : a.map(walk));
  const out = {};
  for (const [name, obj] of Object.entries(objects)) {
    out[name] = {
      ...obj,
      geometries: obj.geometries.map((g) => (g.arcs ? { ...g, arcs: walk(g.arcs) } : g)),
    };
  }
  const sub = { type: "Topology", objects: out, arcs };
  if (topo.transform) sub.transform = topo.transform;
  sub.bbox = arcsBbox(sub);
  return sub;
}

/** [west, south, east, north] of a topology's arcs, in its coordinates. */
export function arcsBbox(topo) {
  const t = topo.transform;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const arc of topo.arcs) {
    let x = 0, y = 0;
    for (const [dx, dy] of arc) {
      if (t) { x += dx; y += dy; } else { x = dx; y = dy; }
      const lon = t ? x * t.scale[0] + t.translate[0] : x;
      const lat = t ? y * t.scale[1] + t.translate[1] : y;
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
  }
  return [w, s, e, n].map((v) => Math.round(v * 1e5) / 1e5);
}

/** { base, parts: { level: { key: topology } } } — a level absent from the
 *  bundle has no parts. */
export function splitTopology(topo) {
  const objects = { ...topo.objects };
  const parts = {};
  for (const [level, partOf] of Object.entries(PART_OF)) {
    const obj = objects[level];
    if (!obj) continue;
    delete objects[level];
    const byKey = {};
    for (const g of obj.geometries) (byKey[partOf(g.properties.geosid)] ??= []).push(g);
    parts[level] = {};
    for (const [key, geometries] of Object.entries(byKey)) {
      parts[level][key] = subsetTopology(topo, { [level]: { ...obj, geometries } });
    }
  }
  const base = subsetTopology(topo, objects);
  base.bbox = topo.bbox ?? base.bbox;
  return { base, parts };
}
