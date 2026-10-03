# Colour Accessibility Audit — Colour-Vision Deficiency (CVD) Legibility

**Date:** 2026-08-09
**Scope:** All user-facing colours in the UNI·CEN frontend (`frontend/src/`), with emphasis on colours that *encode information* — map fills, selection outlines, and chart series. Backend serves data only and defines no colours.
**Status:** Findings below describe the app as audited. A visual companion with rendered before/after chart demonstrations is at [`colour-accessibility-report.html`](colour-accessibility-report.html).

**Implementation status (2026-08-09):** the following recommendations have since been implemented — focal green darkened to `#00a63c` (3.22:1 on white, §3.3; chosen over the `#00b33c` example because it clears the 3:1 graphics minimum while keeping ≥4.5:1 for the dark button text); LongitudinalPlot lines thickened to width 3 with the reference dashed (§3.2); NCPlot marklines now solid focal / dashed reference with "Focal"/"Ref" end labels (§3.2); OrdPlot bars carry percentage labels (§3.2, label variant); CatPlot segments have white separator borders and inside percentage labels (§3.1, labels part). Still open: the Okabe-Ito palette swap (§3.1), legend/map blend mismatch (§3.4), light-decile border contrast and dark-mode hint (§3.5).

---

## 1. Methodology

- **CVD simulation:** Machado, Oliveira & Fernandes (2009) transformation matrices at severity 1.0 for the three dichromatic conditions — **protanopia** (no L-cones, ~1% of males), **deuteranopia** (no M-cones, ~1% of males; the anomalous trichromat forms of these two together affect ~8% of males and ~0.5% of females), and **tritanopia** (no S-cones, rare). Applied in linear RGB.
- **Distinguishability metric:** pairwise **CIELAB ΔE (CIE76)** between simulated colours. Rule of thumb used here: **ΔE < 20 = hard to tell apart at a glance** (small map polygons, thin lines, chart segments); **ΔE < 10 = effectively identical**.
- **Contrast:** WCAG 2.1 relative-luminance contrast ratios. Thresholds: **3:1** for meaningful graphical objects (SC 1.4.11), **4.5:1** for normal text (SC 1.4.3).
- **Guiding principle:** WCAG SC 1.4.1 *Use of Colour* — colour must never be the **only** visual means of conveying information. Redundant cues (texture, dash pattern, symbol shape, label) fix a colour problem more robustly than any palette swap.

All figures below are reproducible with the script in [Appendix A](#appendix-a--reproducible-simulation-script).

---

## 2. Findings (ordered by severity)

### 2.1 HIGH — Categorical chart palette collapses under CVD, and colour is the sole encoding

**Where:** [`CatPlot.jsx:22–29`](../frontend/src/CatPlot.jsx) — 100 % stacked bar of census category shares.

The palette is ColorBrewer **Set1** (red, blue, green, purple, orange) plus grey `#bbbbbb`. Set1 is documented as *not* colour-blind safe. Measured simulated ΔE:

| Pair | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|
| blue `#377eb8` vs purple `#984ea3` | **11.5** | **10.0** | ok |
| green `#4daf4a` vs orange `#ff7f00` | **14.3** | ok | ok |
| red `#e41a1c` vs green `#4daf4a` | ok | **21.1** | ok |
| red `#e41a1c` vs orange `#ff7f00` | ok | **22.6** | ok |
| blue `#377eb8` vs green `#4daf4a` | ok | ok | **17.6** |

This is compounded by the encoding being **colour-only**: the y-axis category labels are hidden (`CatPlot.jsx:113`, `axisLabel: { show: false }`) and segments carry no text, so the legend (`CatPlot.jsx:85–89`) is the sole decoder. A deuteranopic user cannot reliably map a mustard-coloured segment back to "red" vs "green" in the legend — both render as near-identical olive.

### 2.2 HIGH — Focal/reference series differ by colour alone in three charts

**Where:**
- [`OrdPlot.jsx:131,139`](../frontend/src/OrdPlot.jsx) — adjacent bars, identical shape, no legend (`legend: { show: false }`).
- [`LongitudinalPlot.jsx:110–113,123–126`](../frontend/src/LongitudinalPlot.jsx) — two lines, both `symbol: "circle"`, both `width: 2`, solid, no legend.
- [`NCPlot.jsx:205,212`](../frontend/src/NCPlot.jsx) — two markLines, both `type: "dashed"`, both `width: 2`, labels hidden.

The focal/reference hue pair itself is CVD-safe (see §2.6), but these charts violate WCAG 1.4.1 outright: any user who struggles with *these particular* colours — including low-vision users and greyscale printing — has no fallback cue. NCPlot at least has coloured text labels below the chart (`NCPlot.jsx:258,264`), but the two markLines on the plot itself are indistinguishable except by hue.

### 2.3 MEDIUM — Choropleth decile ramp: ordering survives, adjacent bins compress

**Where:** [`ChoroplethMap.jsx:12–35`](../frontend/src/ChoroplethMap.jsx) — hand-rolled reversed-inferno ramp, sampled at 10 decile midpoints (`ChoroplethMap.jsx:308–320`).

**Positive:** lightness decreases monotonically along the ramp, so the *ordering* of values survives every CVD type — a fundamentally sound design choice.

**Problem:** with 10 bins, adjacent deciles are already close for normal vision, and CVD compresses the midrange further:

- **Protanopia:** deciles 6–9 nearly merge — D7/D8 ΔE 8.4, D8/D9 ΔE 8.9, D6/D7 ΔE 10.0 (all render as very similar dark navy).
- **Deuteranopia:** D8/D9 ΔE 9.3; most adjacent pairs 13–18.
- **Tritanopia:** the entire ramp flattens to a red→dark-red band; adjacent pairs ΔE 9–15.

Users can still read "low vs high" but cannot reliably match a mid-range polygon to its legend swatch.

### 2.4 MEDIUM — Legend swatches don't match rendered map colours

**Where:** [`ChoroplethMap.jsx:588`](../frontend/src/ChoroplethMap.jsx) — `.leaflet-overlay-pane { mix-blend-mode: multiply; }`.

Every polygon fill is multiply-blended with the basemap raster, darkening and shifting the on-screen colour, while the legend swatches (`ChoroplethMap.jsx:766–828`) are plain unblended divs. For a CVD user already working with a compressed ramp (§2.3), this legend/map mismatch removes the one reliable decoding tool. (Polygons are also drawn at `fillOpacity: 0.7`, a further shift the legend doesn't reflect.)

### 2.5 MEDIUM — Focal selection outline fails non-text contrast on the basemap

**Where:** [`config.js:2`](../frontend/src/config.js) (`COLOR_FOCAL = "#00e64d"`), applied at [`ChoroplethMap.jsx:386,417`](../frontend/src/ChoroplethMap.jsx).

`#00e64d` against the light basemap / white map background is **1.69 : 1** — well below the 3 : 1 WCAG 1.4.11 minimum for meaningful graphics. This hurts *all* users, and protanopes see the green as a still-lighter yellow-olive. The magenta reference outline is 3.14 : 1 (passes, barely). The weight-6 outline helps, but on light polygons the focal highlight can effectively vanish.

### 2.6 POSITIVE — The green/magenta focal/reference pair is CVD-safe

`COLOR_FOCAL #00e64d` vs `COLOR_REF #ff00ff`: simulated ΔE ≥ 25 under all three conditions (protanopia ~52, deuteranopia ~45, tritanopia ~57). To a red-green-blind user the pair reads roughly as *yellow vs blue* — still clearly distinct. **Recommendation: keep these hues** (with the contrast fix from §2.5); the problems in §2.2 are about missing redundant cues, not the colours themselves.

Also positive: the **no-data hatch** ([`ChoroplethMap.jsx:592–597`](../frontend/src/ChoroplethMap.jsx)) encodes "missing" with *texture + colour* — the model pattern the rest of the app should follow. The no-data blue `#a8c8e8` stays distinct from every decile colour under all three simulations (ΔE ≥ 25).

### 2.7 LOW — Assorted

- **Lightest decile vs white polygon borders/basemap:** ~1.66 : 1 — the lightest bin nearly disappears into borders at low zoom. A thin grey border or slightly darker first stop would fix it.
- **Province boundaries** `#777777` ([`ChoroplethMap.jsx:661`](../frontend/src/ChoroplethMap.jsx)): distinguished by weight/opacity as well as colour — acceptable.
- **Hover highlight** (`ChoroplethMap.jsx:503`): black outline + weight change — redundantly encoded, fine.
- **Percent/Absolute switch** (`App.jsx:1446`): red/blue track colour is redundant with its text label — fine.
- **Stale comment** [`LongitudinalPlot.jsx:10`](../frontend/src/LongitudinalPlot.jsx) claims focal `#377eb8` / ref `#4daf4a`; the code uses `COLOR_FOCAL`/`COLOR_REF`. Worth deleting to avoid future confusion.
- **Noted in passing (not CVD):** the "No map data" hint ([`ChoroplethMap.jsx:760`](../frontend/src/ChoroplethMap.jsx)) hard-codes light-mode colours (`#555` on translucent white) and is unreadable in dark mode.

---

## 3. Recommendations

Approach: **swap unsafe palettes, add redundant non-colour cues, keep the app's overall look.** Rendered demonstrations of each chart change are in [`colour-accessibility-report.html`](colour-accessibility-report.html).

### 3.1 CatPlot — replace Set1 with an Okabe-Ito subset and stop relying on colour alone

Replace the palette at `CatPlot.jsx:22–29` with this 6-colour subset of the **Okabe-Ito** CVD-safe palette. The subset was chosen by exhaustive search over Okabe-Ito colours (+ grey) to maximize the *worst-case* pairwise ΔE across normal vision and all three simulated CVD types: **worst pair ΔE 24.8** (sky blue vs blue under tritanopia), versus **10.0** for the current Set1 (blue vs purple under deuteranopia) — a 2.5× improvement in the worst case, with no pair anywhere near the "effectively identical" ΔE < 10 zone.

| Slot | Current (Set1) | Proposed (Okabe-Ito subset) |
|---|---|---|
| 1 | `#e41a1c` red | `#D55E00` vermillion |
| 2 | `#377eb8` blue | `#56B4E9` sky blue |
| 3 | `#4daf4a` green | `#F0E442` yellow |
| 4 | `#984ea3` purple | `#0072B2` blue |
| 5 | `#ff7f00` orange | `#000000` black |
| 6 | `#bbbbbb` grey | `#999999` grey |

(The ordering alternates light/dark so stack-adjacent segments also differ in lightness, which survives *any* vision deficiency and greyscale printing.)

Additionally, add a non-colour cue so the legend isn't the sole decoder: show the percentage + category name inside/beside segments wide enough to fit (`label.show` with a minimum-width formatter), and/or apply ECharts `itemStyle.decal` patterns (dots/hatch) to alternate series. If vertical space allows, un-hide the y-axis row labels (`CatPlot.jsx:113`) — currently row identity also leans on the offset label hack at `CatPlot.jsx:54–66`.

### 3.2 Focal/reference charts — add redundant cues (keep the hues)

- **LongitudinalPlot:** focal = solid line + circle symbols; reference = **dashed** line + **triangle** symbols. Slightly darken the focal line for on-white contrast (e.g. `#00b33c`; the map outline can stay brighter if a casing is added, §3.3).
- **NCPlot:** focal markLine **solid**, reference markLine **dashed**, and enable the markLine end labels ("F"/"R" or the geography names) instead of `label: { show: false }`.
- **OrdPlot:** give the reference series an `itemStyle.decal` hatch (ECharts built-in) and/or a contrasting bar border so the pairs read as "plain vs textured", not "green vs magenta".

### 3.3 Map focal outline — fix contrast

Keep the green hue but ensure ≥ 3 : 1 against the light basemap. Options (either suffices):
- darken `COLOR_FOCAL` toward `#009933`–`#00b33c` for map outlines, or
- draw a dark casing under both selection outlines (e.g. a weight-8 `#003010` line under the weight-6 green; same pattern for magenta) — this guarantees visibility on *any* underlying polygon colour, which a single hue can never do.

### 3.4 Choropleth legend/map mismatch

Make the legend truthful: render legend swatches through the same pipeline as the map — apply `mix-blend-mode: multiply` over a basemap-grey background and 0.7 opacity to the swatch divs — or drop the multiply blend (it exists to let basemap labels show through; `fillOpacity: 0.7` already does most of that). Per the chosen scope the inferno-style ramp itself stays; as a further mitigation for the tight deciles (§2.3), an interactive affordance (hovering a legend swatch highlights that decile's polygons) decodes bins without relying on colour matching at all.

### 3.5 Small fixes

- Slightly darken the first ramp stop (e.g. `#f5ee5e` → keeps character, lifts border contrast), or give polygons a light-grey rather than white border.
- Delete the stale colour comment at `LongitudinalPlot.jsx:10`.
- (Drive-by, non-CVD) theme the "No map data" hint at `ChoroplethMap.jsx:760` like its sibling notice at `ChoroplethMap.jsx:746–752`.

---

## 4. Priority summary

| # | Issue | Severity | Fix effort | Reference |
|---|---|---|---|---|
| 2.1 | Set1 palette + colour-only categories (CatPlot) | High | Low — palette swap + labels | §3.1 |
| 2.2 | No redundant focal/ref cues in 3 charts | High | Low — dash/symbol/decal | §3.2 |
| 2.5 | Focal outline 1.69:1 contrast | Medium | Low — darker green or casing | §3.3 |
| 2.4 | Legend ≠ rendered map colours | Medium | Low–medium | §3.4 |
| 2.3 | Decile ramp midrange compression | Medium | Mitigated by 3.4 + legend interactivity | §3.4 |
| 2.7 | Lightest decile vs white; stale comment; dark-mode hint | Low | Trivial | §3.5 |

---

## Appendix A — Reproducible simulation script

Run from anywhere with Node ≥ 18. Prints pairwise simulated ΔE for the audited palettes and the WCAG contrast figures cited above.

```bash
node --input-type=module -e '
const M = {
  protanopia: [[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
  deuteranopia: [[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
  tritanopia: [[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]],
};
const hex2rgb = h => [1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255);
const s2l = c => c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4;
const clamp = c => Math.min(1,Math.max(0,c));
const simulate = (hex,type) => M[type].map(r=>{const l=hex2rgb(hex).map(s2l);return clamp(r[0]*l[0]+r[1]*l[1]+r[2]*l[2]);});
function lin2lab([r,g,b]){
  const X=0.4124*r+0.3576*g+0.1805*b, Y=0.2126*r+0.7152*g+0.0722*b, Z=0.0193*r+0.1192*g+0.9505*b;
  const f=t=>t>0.008856?Math.cbrt(t):(7.787*t+16/116);
  const fx=f(X/0.95047), fy=f(Y), fz=f(Z/1.08883);
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
const dE=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const lum=h=>{const[r,g,b]=hex2rgb(h).map(s2l);return 0.2126*r+0.7152*g+0.0722*b;};
const contrast=(h1,h2)=>{const[a,b]=[lum(h1),lum(h2)].sort((x,y)=>y-x);return((a+0.05)/(b+0.05)).toFixed(2);};
function audit(name, entries){
  console.log("\n=== "+name+" ===");
  for(const type of Object.keys(M)){
    const sims=entries.map(([l,h])=>[l,lin2lab(simulate(h,type))]);
    const rows=[];
    for(let i=0;i<sims.length;i++)for(let j=i+1;j<sims.length;j++){
      const d=dE(sims[i][1],sims[j][1]);
      if(d<25) rows.push(`  ${sims[i][0]} vs ${sims[j][0]}: dE=${d.toFixed(1)}`);
    }
    console.log(type+(rows.length?":\n"+rows.join("\n"):": all pairs dE>=25 (OK)"));
  }
}
audit("Focal/Ref", [["FOCAL","#00e64d"],["REF","#ff00ff"]]);
audit("Set1+grey", [["red","#e41a1c"],["blue","#377eb8"],["green","#4daf4a"],["purple","#984ea3"],["orange","#ff7f00"],["grey","#bbbbbb"]]);
audit("Proposed Okabe-Ito subset (worst pair 24.8)", [["vermillion","#D55E00"],["skyblue","#56B4E9"],["yellow","#F0E442"],["blue","#0072B2"],["black","#000000"],["grey","#999999"]]);
const stops=[[0,"#fbf976"],[0.15,"#e65136"],[0.35,"#b63655"],[0.55,"#88226a"],[0.75,"#550f6d"],[0.9,"#1f0c48"],[1,"#000004"]];
const interp=t=>{let i=0;while(i<stops.length-1&&t>stops[i+1][0])i++;
  const[t0,c0]=stops[i],[t1,c1]=stops[Math.min(i+1,stops.length-1)];
  const f=t1===t0?0:(t-t0)/(t1-t0),a=hex2rgb(c0),b=hex2rgb(c1);
  return "#"+a.map((v,k)=>Math.round((v+(b[k]-v)*f)*255).toString(16).padStart(2,"0")).join("");};
const deciles=[...Array(10)].map((_,i)=>[`D${i+1}`,interp(0.05+i*0.1)]);
audit("Decile ramp", deciles);
audit("No-data vs deciles", [["noData","#a8c8e8"],...deciles]);
console.log("\n=== WCAG contrast ===");
console.log("focal #00e64d on white:", contrast("#00e64d","#ffffff"));
console.log("ref #ff00ff on white:", contrast("#ff00ff","#ffffff"));
console.log("province #777777 on white:", contrast("#777777","#ffffff"));
console.log("lightest decile on white:", contrast(interp(0.05),"#ffffff"));
'
```
