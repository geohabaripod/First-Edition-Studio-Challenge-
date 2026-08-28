# Wiring the real database into the existing dashboard file

## 1. Load the new script
In your HTML, before your existing `<script>`, add:
```html
<script src="api-data-loader.js"></script>
```

## 2. Delete from the original file
- **Section 0** (`mulberry32`, `rnd`) — no longer needed, nothing left uses randomness.
- **Section 1** (`GENERATE WARD MOSAIC`) — the `verts`, `wards` (initial build), `WARD_NAMES`, `riverPts`, `riverPathD`, `distToRiver`, `arterialA`, `arterialB` blocks. All of this is replaced by real geometry from the API.
- **Section 2** (`ATTRIBUTES PER WARD`) — the `wards.forEach(...)` attribute-generation block, `clamp01`, `pickLandcover`, `generateGT`. Real attributes now come from `rasterAll` / `risk` via the loader.
- **Section 3** (`RISK MODEL`) — `computeRisk()` and its call. The API's `/api/risk` endpoint does this now (same formula, server-side).

Keep sections 4 (`COLOR SCALES`) and everything from section 5 (`STATE`) onward as-is — they only read from the `wards` array and don't care whether it was generated or fetched.

## 3. Replace the bottom of the file (section 12, INIT)
Original:
```js
renderMap();
renderLegend();
renderStats();
```
Replace with:
```js
let wards = [];             // now populated async — was `const` before, must be `let`
let studyAreaPathD = null;
let roadFeatures = [];
let riverFeatures = [];
let groundTruthFeatures = [];
let buildingPaths = [];     // filled lazily when the buildings overlay is toggled on

async function bootstrap() {
  document.getElementById('mapTitleTag').textContent = 'Loading…';
  try {
    const data = await window.FloodDataAPI.loadRealData();
    wards = data.wards;
    studyAreaPathD = data.studyAreaPathD;
    roadFeatures = data.roadFeatures;
    riverFeatures = data.riverFeatures;
    groundTruthFeatures = data.groundTruthFeatures;

    wards.forEach(w => { wardJump.appendChild(new Option(w.name, w.id)); }); // if not already populated in section 6

    renderMap();
    renderLegend();
    renderStats();
    document.getElementById('mapTitleTag').textContent = FILL_DEFS[state.fillLayer].label;
  } catch (err) {
    console.error('Failed to load data from API:', err);
    document.getElementById('mapTitleTag').textContent = 'Failed to load — check API connection';
  }
}
bootstrap();
```

## 4. Update the overlay-drawing block inside `renderMap()`
The original draws roads/rivers/study-area from synthetic `arterialA/B`, `riverPts`, `verts`. Swap those three blocks for:

```js
if (state.overlays.roads) {
  roadFeatures.forEach(d => gOverlays.appendChild(el('path', { d, class: 'overlay-road-major' })));
}
if (state.overlays.rivers) {
  riverFeatures.forEach(d => {
    gOverlays.appendChild(el('path', { d, class: 'overlay-river', 'stroke-width': 5 }));
    gOverlays.appendChild(el('path', { d, class: 'overlay-river', 'stroke-width': 2, opacity: 0.9 }));
  });
}
if (state.overlays.studyArea && studyAreaPathD) {
  gOverlays.appendChild(el('path', { d: studyAreaPathD, class: 'overlay-boundary' }));
}
if (state.overlays.groundTruth) {
  groundTruthFeatures.forEach(pt => {
    gOverlays.appendChild(el('circle', { cx: pt.x, cy: pt.y, r: 5, class: 'overlay-gt-ring' }));
    gOverlays.appendChild(el('circle', { cx: pt.x, cy: pt.y, r: 2.4, class: 'overlay-gt-dot' }));
  });
}
if (state.overlays.buildings) {
  if (buildingPaths.length === 0) {
    window.FloodDataAPI.loadBuildingsInView().then(paths => { buildingPaths = paths; renderMap(); });
  } else {
    buildingPaths.forEach(d => gOverlays.appendChild(el('path', { d, class: 'overlay-building-real' })));
  }
}
```
(Add an `.overlay-building-real { fill: var(--...); }` CSS rule — the original `.overlay-building` was a 4.5×4.5 rect style meant for synthetic points, not real building footprints.)

## 5. Ward detail panel
`renderWardDetail()` and `showTooltip()` already just read fields off a `wards` entry (`w.elevation`, `w.riskScore`, etc.) — no changes needed there since the loader produces the same field names.

## 6. What still needs your input
- **`config.js` in the backend** — table/column names are best-guess placeholders. Run `\dt silver.*` and `\d silver.<table>` in psql and correct them.
- **`landcoverClassMap`** in `config.js` — maps your raster's actual pixel codes to `builtup/vegetation/bare/water`.
- **Population raster semantics** — the loader assumes it's a per-pixel count raster and sums it per ward (`stat: 'sum'`). If it's a density raster instead, change `stat` to `'mean'` and multiply by ward area.
- **CORS_ORIGIN / API_BASE** — set to wherever you actually serve the frontend from.
