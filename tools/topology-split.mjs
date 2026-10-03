// tools/topology-split.mjs
//
// Split a census year's TopoJSON bundle so census tracts load per CMA:
//   base           every object except `ct`, with only the arcs they use
//   ct[<cmauid>]   one topology per CMA holding that CMA's tracts
// Tracts exist only inside CMAs and their ids start with the CMA code
// (5350001.00 → 535); every tract prefix has a CMA polygon in its year
// (checked 1951-2021). Arcs are copied as-is (still quantized, delta-encoded
// under the same transform), so geometry is byte-for-byte what the original
// bundle decodes to.

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

/** CMA code of a tract id. */
export const cmaOfTract = (geosid) => String(geosid).slice(0, 3);

/** { base, ct: { cmauid: topology } } — ct is {} for years without tracts. */
export function splitByCma(topo) {
  const { ct, ...rest } = topo.objects;
  const base = subsetTopology(topo, rest);
  base.bbox = topo.bbox ?? base.bbox;
  const byCma = {};
  for (const g of ct?.geometries ?? []) (byCma[cmaOfTract(g.properties.geosid)] ??= []).push(g);
  const out = {};
  for (const [cma, geometries] of Object.entries(byCma)) {
    out[cma] = subsetTopology(topo, { ct: { ...ct, geometries } });
  }
  return { base, ct: out };
}
