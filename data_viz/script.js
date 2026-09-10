/* ============================================================
   COLOR SCALES
============================================================ */
function lerp(a,b,t){return a+(b-a)*t;}
function hexToRgb(h){h=h.replace('#','');return [parseInt(h.substr(0,2),16),parseInt(h.substr(2,2),16),parseInt(h.substr(4,2),16)];}
function rgbToHex(r,g,b){return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');}
function ramp(hexA,hexB,t){
  const a=hexToRgb(hexA), b=hexToRgb(hexB);
  return rgbToHex(lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t));
}
/**
 * Multi-stop ramp: t in [0,1] is mapped onto the (n-1) segments between
 * n hex color stops, then interpolated within whichever segment it falls
 * into via the existing 2-color ramp(). With a 2-stop array this behaves
 * identically to calling ramp() directly, so it's a safe drop-in for every
 * FILL_DEFS gradient, including the 2-stop ones (e.g. popExposed).
 */
function rampMulti(stops,t){
  const n = stops.length - 1;
  const scaled = Math.max(0, Math.min(1, t)) * n;
  const idx = Math.min(Math.floor(scaled), n - 1);
  const localT = scaled - idx;
  return ramp(stops[idx], stops[idx+1], localT);
}
const RISK_COLORS = {Low:'#3f8f5f',Moderate:'#e0b23e',High:'#e17a34',Severe:'#c23f3f'};
const LANDCOVER_COLORS = {
  water:     '#3f82b5',
  trees:     '#3f8f5b',
  grassland: '#78a85a',
  cropland:  '#b6a94a',
  shrubland: '#8b9d55',
  builtup:   '#c96b3c',
  bare:      '#c8b27a',
  wetlands:  '#5b9e8c',
  snow:      '#e8edf0',
};
const LANDCOVER_LABELS = {
  water:     'Water body',
  trees:     'Trees',
  grassland: 'Grassland',
  cropland:  'Cropland',
  shrubland: 'Shrubland',
  builtup:   'Built-up',
  bare:      'Bare ground',
  wetlands:  'Wetlands',
  snow:      'Snow / Ice',
};

const FILL_DEFS = {
  dem:        {label:"DEM (Elevation)", unit:"m a.s.l. (norm.)", type:"gradient", stops:['#f5e6c8','#d8c28f','#a6b86a','#5f8f5b','#3d6f62','#274b6b'], get:w=>w.elevation, min:"Low",max:"High"},
  slope:      {label:"Slope", unit:"degrees (norm.)", type:"gradient", stops:['#f7f7f7','#d9ead3','#b6d7a8','#f6d365','#e89b3c','#a85d2a','#663c24'], get:w=>w.slope, min:"Flat",max:"Steep"},
  drainageDensity:{label:"Drainage Distance", unit:"km/km² (norm.)", type:"gradient", stops:['#f1fbfa','#c7eeeb','#8bd8d2','#4fbdb7','#159a9c','#087f8c','#064c59'], get:w=>w.drainageDensity, min:"Sparse",max:"Dense"},
  rainfall:   {label:"Rainfall", unit:"annual total (norm.)", type:"gradient", stops:['#f7fcff','#d9f0ff','#a6d8f5','#5fb0e8','#2171b5','#08519c','#08306b'], get:w=>w.rainfall, min:"Low",max:"High"},
  buildingDensity:{label:"Building Density", unit:"units/ha (norm.)", type:"gradient", stops:['#faf7ff','#e4d9f5','#c7b5e3','#9b7fe0','#7552b5','#54278f','#32145f'], get:w=>w.buildingDensity, min:"Low",max:"High"},
  population: {label:"Population", unit:"persons (norm.)", type:"gradient", stops:['#fff5f9','#fde0ec','#f7b6d2','#e76f9f','#c43d7a','#a50f6b','#6a0055'], get:w=>w.population, min:"Low",max:"High", raw:w=>w.population},
  landcover:  {label:"Landcover", unit:"class", type:"categorical", get:w=>w.landcover, cats:LANDCOVER_COLORS, labels:LANDCOVER_LABELS},
  risk:       {label:"Risk Map", unit:"class", type:"categorical", get:w=>w.riskClass, cats:RISK_COLORS, labels:{Low:'Low',Moderate:'Moderate',High:'High',Severe:'Severe'}},
  popExposed: {label:"Population Exposed", unit:"persons (norm.)", type:"gradient", stops:['#2a1616','#e3453b'], get:w=>w.popExposed, min:"Low",max:"High", raw:w=>w.popExposed}
};

// Min/max per gradient layer, computed once wards load (see bootstrap()).
// colorForWard() uses this to normalize raw zonal-stat values (elevation in
// meters, rainfall totals, etc.) into the 0..1 range ramp() expects — without
// it, every ward gets the same out-of-range, effectively-identical color.
const FILL_RANGES = {};

function computeFillRanges(wardList){
  Object.keys(FILL_DEFS).forEach((key) => {
    const def = FILL_DEFS[key];
    if(def.type !== 'gradient') return;
    const values = wardList.map(def.get);
    FILL_RANGES[key] = { min: Math.min(...values), max: Math.max(...values) };
  });
}

function colorForWard(varKey, w){
  const def = FILL_DEFS[varKey];
  if(!def) return '#22343a';
  if(def.type==='gradient'){
    const range = FILL_RANGES[varKey];
    const raw = def.get(w);
    let t = 0.5; // flat input (or ranges not computed yet) -> mid ramp
    if(range && range.max > range.min){
      t = (raw - range.min) / (range.max - range.min);
    }
    t = Math.max(0, Math.min(1, t));
    return rampMulti(def.stops, t);
  }
  return def.cats[def.get(w)] || '#22343a';
}

/* ============================================================
    WARD LABEL POINT — "pole of inaccessibility"
   ------------------------------------------------------------
   Neither layer.getBounds().getCenter() (bbox center) nor an
   area-weighted centroid ("center of mass") are guaranteed to fall
   INSIDE a polygon — both can land outside for concave, L-shaped, or
   narrow-waisted wards, which is exactly the "values outside the ward"
   symptom being fixed here.

   The correct tool for label placement is the point that is as far as
   possible from every edge of the polygon (its "pole of inaccessibility",
   the same technique Mapbox's polylabel uses for map labels). By
   construction this point must be inside the polygon (its distance to
   every edge is positive), so it can never land outside — the guarantee
   a centroid can't offer.

   This is a quadtree best-first search: start with a coarse grid of
   candidate cells covering the polygon's bounding box, repeatedly expand
   whichever cell could *possibly* contain a better answer than what's
   already been found (bounded by cell.d + cell.h*sqrt(2)), and discard
   the rest. It converges to within `precision` of the true optimum.
============================================================ */

/** Squared distance from point (px,py) to the segment (x1,y1)-(x2,y2). */
function pointToSegDistSq(px, py, x1, y1, x2, y2){
  let x = x1, y = y1, dx = x2 - x1, dy = y2 - y1;
  if(dx !== 0 || dy !== 0){
    const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    if(t > 1){ x = x2; y = y2; }
    else if(t > 0){ x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

/**
 * Signed distance from (x,y) to the polygon boundary defined by `rings`
 * (outer ring + any hole rings, GeoJSON-style). Positive = inside,
 * negative = outside. Inside/outside uses the standard even-odd ray-cast
 * rule, which correctly handles holes when they're included in `rings`.
 */
function pointToPolygonDist(x, y, rings){
  let inside = false;
  let minDistSq = Infinity;
  for(const ring of rings){
    for(let i = 0, len = ring.length, j = len - 1; i < len; j = i++){
      const a = ring[i], b = ring[j];
      if((a[1] > y) !== (b[1] > y) &&
         (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
      minDistSq = Math.min(minDistSq, pointToSegDistSq(x, y, a[0], a[1], b[0], b[1]));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minDistSq);
}

/** Area-weighted centroid of a ring, used only as a seed candidate below. */
function ringCentroid(ring){
  const n = ring.length - 1;
  let area = 0, cx = 0, cy = 0;
  for(let i = 0; i < n; i++){
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;
  if(Math.abs(area) < 1e-12){
    let sx = 0, sy = 0;
    for(let i = 0; i < n; i++){ sx += ring[i][0]; sy += ring[i][1]; }
    return [sx / n, sy / n];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/**
 * Pole of inaccessibility for a single polygon part (rings = [outerRing,
 * ...holeRings]). Returns [x, y, distanceToBoundary].
 */
function polylabel(rings){
  const outer = rings[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for(const [x, y] of outer){
    if(x < minX) minX = x; if(x > maxX) maxX = x;
    if(y < minY) minY = y; if(y > maxY) maxY = y;
  }
  const width = maxX - minX, height = maxY - minY;
  const cellSize = Math.min(width, height);
  if(cellSize <= 0) return [minX, minY, 0];

  // Precision scaled to the polygon's own size rather than a fixed
  // absolute value — lon/lat degrees span a huge range of ward sizes here.
  const precision = cellSize * 0.005;

  let h = cellSize / 2;
  const makeCell = (x, y, h) => {
    const d = pointToPolygonDist(x, y, rings);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };

  let queue = [];
  for(let x = minX; x < maxX; x += cellSize){
    for(let y = minY; y < maxY; y += cellSize){
      queue.push(makeCell(x + h, y + h, h));
    }
  }

  // Seed with the area centroid and the plain bbox center — often close
  // to optimal already, so this tends to speed up convergence.
  const [cx, cy] = ringCentroid(outer);
  let best = makeCell(cx, cy, 0);
  const bboxCandidate = makeCell(minX + width / 2, minY + height / 2, 0);
  if(bboxCandidate.d > best.d) best = bboxCandidate;

  let guard = 0;
  while(queue.length && guard++ < 5000){
    // Best-first: process the cell with the highest upper-bound potential.
    queue.sort((a, b) => a.max - b.max);
    const cell = queue.pop();
    if(cell.d > best.d) best = cell;
    if(cell.max - best.d <= precision) continue; // can't beat the current best — drop it
    const half = cell.h / 2;
    queue.push(makeCell(cell.x - half, cell.y - half, half));
    queue.push(makeCell(cell.x + half, cell.y - half, half));
    queue.push(makeCell(cell.x - half, cell.y + half, half));
    queue.push(makeCell(cell.x + half, cell.y + half, half));
  }
  return [best.x, best.y, best.d];
}

/**
 * Best label point for a GeoJSON Polygon or MultiPolygon, in [lon, lat]
 * order. For MultiPolygon, computes polylabel independently per part and
 * keeps the one with the largest distance-to-boundary — i.e. the most
 * "roomy" part, typically the largest, rather than a small disconnected
 * sliver.
 */
function wardLabelPoint(geometry){
  if(!geometry) return null;
  if(geometry.type === 'Polygon'){
    const [x, y] = polylabel(geometry.coordinates);
    return [x, y];
  }
  if(geometry.type === 'MultiPolygon'){
    let best = null;
    geometry.coordinates.forEach((rings) => {
      const [x, y, d] = polylabel(rings);
      if(!best || d > best[2]) best = [x, y, d];
    });
    return best ? [best[0], best[1]] : null;
  }
  return null;
}

/** Leaflet LatLng version of wardLabelPoint(), for direct use with L.marker etc. */
function wardCentroidLatLng(geometry){
  const p = wardLabelPoint(geometry);
  return p ? L.latLng(p[1], p[0]) : null;
}

/* ============================================================
   STATE
============================================================ */
let state = {
  fillLayer:'risk',
  compareLayer:'rainfall',
  compareOn:false,
  swipeX:50,
  selectedWard:null,
  overlays:{ studyArea:true, wardBoundaries:true, roads:false, buildings:false, rivers:false, groundTruth:false },
  opacity:1,
  basemap:'satellite'
};

/* ============================================================
   BUILD SIDEBAR CONTROLS
============================================================ */
const GENERAL_LAYERS = [
  {key:'studyArea', label:'Study Area (Boundary)', color:'#f2f2f2'},
  {key:'wardBoundaries', label:'Ward Boundaries', color:'#8fb0ac'},
  {key:'roads', label:'Roads', color:'#000000'},
  {key:'buildings', label:'Buildings', color:'#f4ede1'},
];
const POINT_LAYERS = [
  {key:'rivers', label:'Rivers / Drainage Network', color:'#4fa9d6'},
  {key:'groundTruth', label:'Ground Truth (flood incidents)', color:'#e3453b'},
];
const FILL_ORDER = ['buildingDensity','dem','drainageDensity','landcover','population','rainfall','slope'];

const generalEl = document.getElementById('generalLayers');
GENERAL_LAYERS.forEach(l=>{
  generalEl.appendChild(makeCheckRow(l.key, l.label, l.color, state.overlays[l.key]));
});
const pointEl = document.getElementById('pointLayers');
POINT_LAYERS.forEach(l=>{
  pointEl.appendChild(makeCheckRow(l.key, l.label, l.color, state.overlays[l.key]));
});

function makeCheckRow(key,label,color,checked){
  const row=document.createElement('div');
  row.className='layer-row'+(checked?' checked':'');
  row.innerHTML=`<input type="checkbox" ${checked?'checked':''} data-key="${key}">
    <span class="swatch" style="background:${color}"></span>
    <label>${label}</label>`;
  row.querySelector('input').addEventListener('change',e=>{
    state.overlays[key]=e.target.checked;
    row.classList.toggle('checked',e.target.checked);
    renderMap();
  });
  row.addEventListener('click',e=>{ if(e.target.tagName!=='INPUT'){ const cb=row.querySelector('input'); cb.checked=!cb.checked; cb.dispatchEvent(new Event('change')); }});
  return row;
}

const fillEl = document.getElementById('fillLayers');
FILL_ORDER.forEach(key=>{
  fillEl.appendChild(makeFillRow(key));
});
const outputEl = document.getElementById('outputLayer');
outputEl.appendChild(makeFillRow('risk'));
outputEl.appendChild(makeFillRow('popExposed'));

function makeFillRow(key){
  const def = FILL_DEFS[key];
  const row=document.createElement('div');
  row.className='fill-row'+(state.fillLayer===key?' active':'');
  const rampCss = def.type==='gradient' ? `linear-gradient(90deg, ${def.stops.join(', ')})` : `linear-gradient(90deg, ${Object.values(def.cats).join(',')})`;
  row.innerHTML=`<input type="radio" name="fillLayer" ${state.fillLayer===key?'checked':''}>
    <label>${def.label}</label>
    <span class="fill-ramp" style="background:${rampCss}"></span>`;
  row.addEventListener('click',()=>{
    document.querySelectorAll('.fill-row').forEach(r=>r.classList.remove('active'));
    row.classList.add('active');
    row.querySelector('input').checked=true;
    state.fillLayer=key;
    document.getElementById('mapTitleTag').textContent=def.label;
    document.getElementById('rightTag').textContent=def.label;
    renderMap(); renderLegend(); renderStats();
  });
  return row;
}

/* compare dropdown */
const compareSelect = document.getElementById('compareSelect');
[...FILL_ORDER,'risk','popExposed'].forEach(k=>{
  const opt=document.createElement('option');
  opt.value=k; opt.textContent=FILL_DEFS[k].label;
  if(k==='rainfall') opt.selected=true;
  compareSelect.appendChild(opt);
});
compareSelect.addEventListener('change',e=>{
  state.compareLayer=e.target.value;
  document.getElementById('leftTag').textContent=FILL_DEFS[state.compareLayer].label;
  renderMap();
});

/* ward jump dropdown — populated once real data arrives, inside bootstrap() */
const wardJump = document.getElementById('wardJump');
wardJump.addEventListener('change',e=>{
  selectWard(e.target.value || null);
});

/* opacity slider */
document.getElementById('opacitySlider').addEventListener('input',e=>{
  state.opacity = e.target.value/100;
  document.getElementById('opVal').textContent = e.target.value+'%';
  renderMap();
});

/* ============================================================
   LEAFLET MAP — wards are a native Leaflet layer (choropleth,
   interactive). Study area / roads / rivers / buildings are static,
   pre-rendered PNGs (see generate-static-layers.js) shown as
   L.imageOverlay — cheap to pan/zoom since there's nothing to
   reproject, unlike thousands of live vector paths.
============================================================ */

let map = null;
let baseLayers = {};
let wardsPane, comparePane, overlaysPane, rasterPane;

function initMap(){
  if(typeof L === 'undefined'){
    console.warn('Leaflet failed to load');
    const bg = document.getElementById('mapBg');
    if(bg) bg.style.background = '#050544';
    return;
  }

  map = L.map('mapBg', {
    zoomControl: true,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    touchZoom: true,
    attributionControl: true,
    zoomSnap: 0.125,          // allow quarter-level zoom stops instead of whole integers
    zoomDelta: 0.125,         // +/- buttons and keyboard zoom move by 0.25 levels
    wheelPxPerZoomLevel: 120
  }).setView([-1.10, 36.95], 13); // re-centered on the real study area once data loads

  baseLayers.streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  });
  baseLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19
  });
  baseLayers[state.basemap].addTo(map);

  // Stacked panes above the tile layer: ward fills, the swipe-compare fill
  // (clipped via CSS to the left of the swipe handle), then the static
  // image overlays + ground truth points.
  wardsPane = map.createPane('wardsPane'); wardsPane.style.zIndex = 410;
  comparePane = map.createPane('comparePane'); comparePane.style.zIndex = 420; comparePane.style.pointerEvents = 'none';
  overlaysPane = map.createPane('overlaysPane'); overlaysPane.style.zIndex = 430;
  // Raster-layer PNGs sit below wardsPane. Ward polygons stay on top with a
  // near-invisible fill (see applyWardStyle) purely to keep hover/click
  // detection working when a raster-backed layer is the active fill.
  rasterPane = map.createPane('rasterPane'); rasterPane.style.zIndex = 405; rasterPane.style.pointerEvents = 'none';
}
initMap();

function setBasemap(type){
  if(!map || !baseLayers[type] || state.basemap===type) return;
  const current = baseLayers[state.basemap];
  if(current && map.hasLayer(current)) map.removeLayer(current);
  baseLayers[type].addTo(map);
  state.basemap = type;
  document.querySelectorAll('.basemap-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.basemap===type);
  });
}
document.querySelectorAll('.basemap-btn').forEach(btn=>{
  btn.addEventListener('click',()=> setBasemap(btn.dataset.basemap));
});

/* ------------------------------------------------------------ */
/* Ward layer (choropleth fill) + compare layer + overlays        */
/* ------------------------------------------------------------ */

let wards = [];
let wardsById = new Map();
let wardsGeoJSON = null;
let wardsLayer = null;
let wardsMappedCount = 0;
const wardLayerById = new Map();

let compareLayerGroup = null;
let groundTruthLayerGroup = null;
// Static (non-interactive) layers: key -> L.imageOverlay. Populated once in
// bootstrap() from generate-static-layers.js's output; toggled on/off same
// as any other overlay via renderMap()/toggleLayer().
const staticOverlayLayers = {};
// Physical raster layers rendered as whole-study-area PNGs (see
// generate-raster-layers.js): key -> L.imageOverlay. Only the one matching
// state.fillLayer is ever shown (see renderMap()).
const rasterOverlayLayers = {};
// risk/popExposed are ward-level computed model outputs, not physical
// rasters, so they default to ward-choropleth rendering. 'risk' is listed
// here too since it CAN be raster-backed once the backend supplies a
// silver.flood_hazard PNG via loadRasterOverlays() — but applyWardStyle()
// only actually switches a key into raster mode once rasterOverlayLayers
// has a real entry for it, so listing a key here alone does not hide the
// ward fill if that PNG hasn't loaded (avoids a blank map).
const RASTER_BACKED_KEYS = new Set(['dem','slope','drainageDensity','rainfall','buildingDensity','population','landcover','risk']);
const popExposedLabelsGroup = (typeof L !== 'undefined') ? L.layerGroup() : null;

function toggleLayer(layer, on){
  if(!layer) return;
  if(on && !map.hasLayer(layer)) layer.addTo(map);
  if(!on && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyWardStyle(layer, id){
  const w = wardsById.get(id);
  // A key only renders as a raster overlay if that overlay actually loaded
  // (i.e. the backend returned it from loadRasterOverlays()). Checking
  // RASTER_BACKED_KEYS alone isn't enough — 'risk' is listed there once the
  // silver.flood_hazard raster is wired up backend-side, but until that
  // PNG actually exists in rasterOverlayLayers, falling through to "raster
  // mode" would just hide the ward fill with nothing to replace it (blank
  // map). Falling back to the ward choropleth keeps something visible.
  const isRasterBacked = RASTER_BACKED_KEYS.has(state.fillLayer) && !!rasterOverlayLayers[state.fillLayer];
  layer.setStyle({
    className: 'ward-poly',
    stroke: false,
    fill: true,
    // Raster-backed layers show the PNG underneath instead — keep the
    // polygon fill nearly (not fully) transparent so it still catches
    // hover/click events rather than disabling pointer interaction.
    fillColor: isRasterBacked ? '#000000' : (w ? colorForWard(state.fillLayer, w) : '#22343a'),
    fillOpacity: isRasterBacked ? 0.001 : 1,
  });
  const domEl = layer.getElement();
  if(domEl){
    domEl.classList.toggle('selected', state.selectedWard === id);
    // Ward boundary stroke is controlled purely via this class (see
    // style.css: .ward-poly has no stroke by default, only
    // .ward-poly.boundaries-on does) — driven by the "Ward Boundaries"
    // checkbox in the sidebar (state.overlays.wardBoundaries).
    domEl.classList.toggle('boundaries-on', state.overlays.wardBoundaries);
  }
}

function attachWardEvents(feature, layer){
  // NOTE: was feature.properties.ward_id, which does not exist anywhere in
  // the API response — routes.js/config.js send the ward id under the
  // property key "id" (config.js -> vector.wards.idCol = 'id'). The old key
  // resolved to "undefined" for every ward, silently breaking color lookups,
  // hover tooltips, and selection.
  const id = String(feature.properties.id);
  wardLayerById.set(id, layer);
  layer.on('click', () => selectWard(id));
  layer.on('mouseover', () => { const w = wardsById.get(id); if(w) showTooltip(w); });
  layer.on('mousemove', (e) => moveTooltip(e.originalEvent));
  layer.on('mouseout', () => hideTooltip());
}

function buildGroundTruthLayer(fc){
  const group = L.layerGroup();
  fc.features.forEach((f) => {
    const [lon, lat] = f.geometry.coordinates;
    L.circleMarker([lat, lon], { pane:'overlaysPane', radius:5, className:'overlay-gt-ring', interactive:false }).addTo(group);
    L.circleMarker([lat, lon], { pane:'overlaysPane', radius:2.4, className:'overlay-gt-dot', interactive:false }).addTo(group);
  });
  return group;
}

/** Wraps a pre-rendered static-layer PNG as a Leaflet image overlay. */
function buildStaticImageLayer(url, latLngBounds){
  return L.imageOverlay(url, latLngBounds, { pane:'overlaysPane', interactive:false });
}

function updateSwipeClip(){
  if(!comparePane) return;
  comparePane.style.clipPath = `inset(0 ${100 - state.swipeX}% 0 0)`;
}

function renderMap(){
  wardsPane.style.opacity = state.opacity;
  comparePane.style.opacity = state.opacity;

  // Ward-dependent rendering only runs if ward data actually loaded. This
  // used to be a single "if(!wardsLayer) return;" guard at the top of the
  // function, which meant a failed ward/API load also skipped the static
  // PNG and raster PNG toggling below — even though those don't depend on
  // wardsLayer at all. Now only the ward-specific block is gated.
  if(wardsLayer){
    wardsLayer.eachLayer((layer) => {
      // NOTE: was layer.feature.properties.ward_id — see attachWardEvents note above.
      applyWardStyle(layer, String(layer.feature.properties.id));
    });

    // compare (swipe) fill
    if(compareLayerGroup){ map.removeLayer(compareLayerGroup); compareLayerGroup = null; }
    if(state.compareOn){
      compareLayerGroup = L.geoJSON(wardsGeoJSON, {
        pane: 'comparePane',
        interactive: false,
        style: (feature) => {
          const id = String(feature.properties.id);
          const w = wardsById.get(id);
          return { className:'ward-poly', stroke:false, fill:true, fillOpacity:1,
            fillColor: w ? colorForWard(state.compareLayer, w) : '#22343a' };
        }
      }).addTo(map);
      updateSwipeClip();
    }

    // on-map value labels for Population Exposed
    popExposedLabelsGroup.clearLayers();
    if(state.fillLayer === 'popExposed'){
      wardsLayer.eachLayer((layer) => {
        // NOTE: was layer.feature.properties.ward_id — see attachWardEvents note above.
        const id = String(layer.feature.properties.id);
        const w = wardsById.get(id);
        if(!w) return;
        // True polygon centroid (area-weighted "center of mass"), not the
        // bounding-box center — see the WARD CENTROID HELPER section above.
        // Falls back to the bbox center only if centroid computation
        // somehow fails (e.g. malformed geometry).
        const center = wardCentroidLatLng(layer.feature.geometry) || layer.getBounds().getCenter();
        const icon = L.divIcon({ className:'ward-value-label', html: formatCount(w.popExposed), iconSize:[0,0] });
        L.marker(center, { icon, interactive:false, pane:'wardsPane' }).addTo(popExposedLabelsGroup);
      });
    }
    if(!map.hasLayer(popExposedLabelsGroup)) popExposedLabelsGroup.addTo(map);
  }

  // Static image overlays (study area, roads, rivers, buildings) — these
  // have no dependency on ward/API data, so they toggle unconditionally,
  // same as the basemap.
  ['studyArea','roads','rivers','buildings'].forEach((key) => {
    toggleLayer(staticOverlayLayers[key], state.overlays[key]);
  });
  toggleLayer(groundTruthLayerGroup, state.overlays.groundTruth);

  // Raster-backed fill layers (dem/slope/.../landcover): show only the one
  // matching the active fill selection, at the current opacity. risk/
  // popExposed have no raster counterpart and stay ward-choropleth (handled
  // above via applyWardStyle/colorForWard). Also independent of ward data.
  Object.keys(rasterOverlayLayers).forEach((key) => {
    const show = state.fillLayer === key;
    toggleLayer(rasterOverlayLayers[key], show);
    if(show) rasterOverlayLayers[key].setOpacity(state.opacity);
  });
}

/* ============================================================
   HOVER TOOLTIP
============================================================ */
const tooltipEl = document.getElementById('mapTooltip');
const stageEl = document.querySelector('.map-stage');
function formatCount(n){
  return n>=1000 ? (n/1000).toFixed(1).replace(/\.0$/,'')+'k' : String(n);
}
function showTooltip(w){
  const activeDef = FILL_DEFS[state.fillLayer];
  const activeVal = activeDef.type==='gradient'
    ? (activeDef.raw ? formatCount(activeDef.raw(w)) : activeDef.get(w).toFixed(2))
    : activeDef.labels[activeDef.get(w)];
  tooltipEl.innerHTML = `
    <div class="tt-name">${w.name}</div>
    <div class="tt-sub">WARD ${w.id} · RISK <span class="tt-chip" style="background:${RISK_COLORS[w.riskClass]}">${w.riskClass}</span></div>
    <div class="tt-row"><span class="k">Population</span><span class="v">${w.population.toLocaleString()}</span></div>
    <div class="tt-row hl"><span class="k">Population exposed</span><span class="v">${w.popExposed.toLocaleString()} (${Math.round(w.riskScore*100)}%)</span></div>
    <div class="tt-row"><span class="k">${activeDef.label}</span><span class="v">${activeVal}</span></div>
    <div class="tt-row"><span class="k">Rainfall</span><span class="v">${w.rainfall.toFixed(2)}</span></div>
  `;
  tooltipEl.classList.add('show');
}
function moveTooltip(e){
  const rect = stageEl.getBoundingClientRect();
  let x = e.clientX-rect.left, y = e.clientY-rect.top;
  const ttW=210, ttH=180;
  if(x+ttW+20>rect.width) x -= (ttW+20);
  if(y+ttH+20>rect.height) y -= (ttH+20);
  tooltipEl.style.transform = `translate(${x+14}px,${y+14}px)`;
}
function hideTooltip(){ tooltipEl.classList.remove('show'); }
function highlightWard(id,on){
  const layer = wardLayerById.get(id);
  const domEl = layer && layer.getElement();
  if(domEl) domEl.classList.toggle('hover-highlight', on);
}
/* Tooltip triggered from the sidebar list (not a map pointer event) —
   pin it inside the map stage rather than tracking a cursor position there. */
function showTooltipAt(w){
  showTooltip(w);
  tooltipEl.style.transform = 'translate(20px,20px)';
  highlightWard(w.id,true);
}

function selectWard(id){
  const prev = state.selectedWard;
  state.selectedWard = id;
  wardJump.value = id||'';
  if(prev){ const domEl = wardLayerById.get(prev)?.getElement(); if(domEl) domEl.classList.remove('selected'); }
  if(id){ const domEl = wardLayerById.get(id)?.getElement(); if(domEl) domEl.classList.add('selected'); }
  if(id) renderWardDetail(id);
  else document.getElementById('wardDetail').innerHTML = '<div class="empty-hint">Select a ward on the map, or from the dropdown above, to see its full attribute profile.</div>';
}

/* ============================================================
   SWIPE HANDLE
============================================================ */
const grip = document.getElementById('swipeGrip');
const handle = document.getElementById('swipeHandle');
let dragging=false;
grip.addEventListener('pointerdown',e=>{dragging=true; e.target.setPointerCapture(e.pointerId);});
window.addEventListener('pointerup',()=>dragging=false);
window.addEventListener('pointermove',e=>{
  if(!dragging) return;
  const stage = document.querySelector('.map-stage').getBoundingClientRect();
  let pct = ((e.clientX-stage.left)/stage.width)*100;
  pct = Math.max(4,Math.min(96,pct));
  state.swipeX=pct;
  updateSwipePos();
});
function updateSwipePos(){
  handle.style.left = state.swipeX+'%';
  updateSwipeClip();
}

/* ============================================================
   LEGEND
============================================================ */
function renderLegend(){
  const def = FILL_DEFS[state.fillLayer];
  const box = document.getElementById('legendBox');
  if(def.type==='gradient'){
    box.innerHTML = `
      <div class="legend-title"><span>${def.label}</span><span class="unit">${def.unit}</span></div>
      <div class="legend-gradient" style="background:linear-gradient(90deg, ${def.stops.join(', ')})"></div>
      <div class="legend-scale"><span>${def.min}</span><span>${def.max}</span></div>`;
  } else {
    let rows='';
    for(const k in def.cats){
      rows+=`<div class="legend-cat-row"><span class="legend-cat-swatch" style="background:${def.cats[k]}"></span>${def.labels[k]}</div>`;
    }
    box.innerHTML = `<div class="legend-title"><span>${def.label}</span><span class="unit">${def.unit}</span></div><div class="legend-cats">${rows}</div>`;
  }
}

/* ============================================================
   STATS PANEL
============================================================ */
function renderStats(){
  if(!wards.length) return; // no ward data loaded — nothing to summarize
  const totalPop = wards.reduce((s,w)=>s+w.population,0);
  const highSevere = wards.filter(w=>w.riskClass==='High'||w.riskClass==='Severe');
  const pctHighSevere = Math.round(highSevere.length/wards.length*100);
  const totalExposed = wards.reduce((s,w)=>s+w.popExposed,0);

  document.getElementById('statGrid').innerHTML = `
    <div class="stat-card"><div class="val">${wardsMappedCount || wards.length}</div><div class="lab">Wards mapped</div></div>
    <div class="stat-card"><div class="val">${(totalPop/1000).toFixed(1)}k</div><div class="lab">Population</div></div>
    <div class="stat-card"><div class="val">${pctHighSevere}%</div><div class="lab">Area high+ risk</div></div>
    <div class="stat-card"><div class="val">${(totalExposed/1000).toFixed(1)}k</div><div class="lab">Pop. exposed</div></div>
  `;

  const classes=['Severe','High','Moderate','Low'];
  const maxCount = wards.length;
  let barsHtml='';
  classes.forEach(c=>{
    const count = wards.filter(w=>w.riskClass===c).length;
    const pct = Math.round(count/maxCount*100);
    barsHtml += `<div class="risk-bar-row">
      <div class="rl">${c}</div>
      <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${pct}%;background:${RISK_COLORS[c]}"></div></div>
      <div class="rv">${count}</div>
    </div>`;
  });
  document.getElementById('riskBars').innerHTML = barsHtml;

  /* Population exposed, broken down per ward, ranked highest first */
  const ranked = [...wards].sort((a,b)=>b.popExposed-a.popExposed);
  const maxExp = ranked[0].popExposed || 1;
  let expHtml='';
  ranked.forEach(w=>{
    const pct = Math.round(w.popExposed/maxExp*100);
    expHtml += `<div class="risk-bar-row exp-row" data-ward="${w.id}">
      <div class="rl" title="${w.name}">${w.name}</div>
      <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${pct}%;background:${RISK_COLORS[w.riskClass]}"></div></div>
      <div class="rv">${formatCount(w.popExposed)}</div>
    </div>`;
  });
  document.getElementById('expBars').innerHTML = expHtml;
  document.querySelectorAll('.exp-row').forEach(r=>{
    r.style.cursor='pointer';
    const wardId = r.dataset.ward;
    r.addEventListener('click',()=>selectWard(wardId));
    r.addEventListener('pointerenter',()=>showTooltipAt(wards.find(w=>w.id===wardId)));
    r.addEventListener('pointerleave',()=>{ hideTooltip(); highlightWard(wardId,false); });
  });
}

/* ============================================================
   WARD DETAIL
============================================================ */
function renderWardDetail(id){
  const w = wards.find(x=>x.id===id);
  if(!w) return;
  document.getElementById('wardDetail').innerHTML = `
    <div class="ward-detail">
      <h3>${w.name}</h3>
      <div class="wsub">WARD ${w.id} — POP ${w.population.toLocaleString()}</div>
      <div class="wd-row"><span class="k">Risk class</span><span class="v"><span class="risk-chip" style="background:${RISK_COLORS[w.riskClass]}">${w.riskClass}</span></span></div>
      <div class="wd-row"><span class="k">Risk score</span><span class="v">${w.riskScore.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Elevation (norm.)</span><span class="v">${w.elevation.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Slope (norm.)</span><span class="v">${w.slope.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Drainage density</span><span class="v">${w.drainageDensity.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Rainfall</span><span class="v">${w.rainfall.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Building density</span><span class="v">${w.buildingDensity.toFixed(2)}</span></div>
      <div class="wd-row"><span class="k">Landcover</span><span class="v">${LANDCOVER_LABELS[w.landcover]}</span></div>
      <div class="wd-row"><span class="k">Ground-truth incidents</span><span class="v">${w.gtPoints.length}</span></div>
    </div>`;
}

/* ============================================================
   INIT
============================================================ */

/**
 * Static PNGs (study area / roads / rivers / buildings) — no DB dependency.
 * Returns the shared bounds so bootstrap() can fall back to it for the
 * initial map fit if ward data fails to load.
 */
async function loadStaticOverlaysLayer(){
  const staticData = await window.FloodDataAPI.loadStaticLayers();
  const staticBounds = L.latLngBounds(staticData.bounds);
  ['studyArea','roads','rivers','buildings'].forEach((key) => {
    staticOverlayLayers[key] = buildStaticImageLayer(staticData.layers[key], staticBounds);
  });
  return staticBounds;
}

/**
 * Raster PNGs (dem/slope/drainageDensity/rainfall/buildingDensity/
 * population/landcover) — no DB dependency, each with its own bounds.
 */
async function loadRasterOverlaysLayer(){
  const rasterData = await window.FloodDataAPI.loadRasterOverlays();
  Object.keys(rasterData).forEach((key) => {
    const b = L.latLngBounds(rasterData[key].bounds);
    rasterOverlayLayers[key] = L.imageOverlay(rasterData[key].url, b, {
      pane: 'rasterPane', interactive: false, opacity: state.opacity,
    });
  });
}

/**
 * Ward choropleth + ground truth points — the DB/API-backed part that can
 * actually fail (see api-data-loader.js -> loadRealData()). Returns the
 * ward layer bounds for the initial map fit.
 */
async function loadWardLayer(){
  const data = await window.FloodDataAPI.loadRealData();
  wards = data.wards;
  wardsById = new Map(wards.map(w => [String(w.id), w]));
  wardsGeoJSON = data.wardsGeoJSON;
  wardsMappedCount = data.wardsMappedCount;
  computeFillRanges(wards); // must run before any renderMap()/colorForWard() call

  wardsLayer = L.geoJSON(wardsGeoJSON, {
    pane: 'wardsPane',
    style: () => ({ className:'ward-poly', stroke:false, fill:true, fillOpacity:1 }),
    onEachFeature: attachWardEvents,
  }).addTo(map);

  groundTruthLayerGroup = buildGroundTruthLayer(data.groundTruthGeoJSON);
  wards.forEach(w => { wardJump.appendChild(new Option(w.name, w.id)); });

  return wardsLayer.getBounds();
}

async function bootstrap() {
  document.getElementById('mapTitleTag').textContent = 'Loading…';

  // Static PNGs, raster PNGs, and ward/API data now load independently —
  // like the basemap tile layer, none of them wait on or get blocked by
  // the others. Previously these were three sequential "await"s inside one
  // try/catch: if loadRealData() (ward/API) threw, the code that loaded the
  // static and raster PNGs — which sat further down in the same try block —
  // never ran at all, so NOTHING appeared on the map when only the DB was
  // down. Promise.allSettled() means a ward/API failure no longer prevents
  // the static and raster overlays from loading and rendering.
  const [staticResult, rasterResult, wardResult] = await Promise.allSettled([
    loadStaticOverlaysLayer(),
    loadRasterOverlaysLayer(),
    loadWardLayer(),
  ]);

  if(staticResult.status === 'rejected'){
    console.error('Failed to load static overlay layers:', staticResult.reason);
  }
  if(rasterResult.status === 'rejected'){
    console.error('Failed to load raster overlay layers:', rasterResult.reason);
  }
  if(wardResult.status === 'rejected'){
    console.error('Failed to load ward data from API:', wardResult.reason);
  }

  // Fit the view to the real ward bounds when available; otherwise fall
  // back to the static-layer bounds so the map still centers on the study
  // area even when only the PNGs loaded successfully. paddingBottomRight
  // accounts for the floating right-panel (320px wide, offset 368px in
  // style.css to clear it) which visually covers that portion of the map
  // canvas — without this, fitBounds treats the full canvas width as
  // available space and the study area ends up off-center behind the panel.
  const fitOpts = { paddingTopLeft: [20, 20], paddingBottomRight: [340, -20] };
  const wardBounds = wardResult.status === 'fulfilled' ? wardResult.value : null;
  const staticBounds = staticResult.status === 'fulfilled' ? staticResult.value : null;
  const boundsToFit =
    (wardBounds && wardBounds.isValid()) ? wardBounds :
    (staticBounds && staticBounds.isValid()) ? staticBounds :
    null;
  if(boundsToFit) map.fitBounds(boundsToFit, fitOpts);

  renderMap();

  if(wardResult.status === 'fulfilled'){
    renderLegend();
    renderStats();
    document.getElementById('mapTitleTag').textContent = FILL_DEFS[state.fillLayer].label;
  } else {
    // Static/raster layers may still be visible via the sidebar toggles even
    // though the ward-dependent panels (legend/stats/detail) have nothing
    // to show.
    document.getElementById('mapTitleTag').textContent = 'Ward data unavailable — base layers only';
  }
}
bootstrap();

/* legend collapse toggle */
const mapLegend = document.getElementById('mapLegend');
document.getElementById('legendCollapseBtn').addEventListener('click',e=>{
  e.stopPropagation();
  const collapsed = mapLegend.classList.toggle('collapsed');
  e.target.textContent = collapsed ? '+' : '–';
});
