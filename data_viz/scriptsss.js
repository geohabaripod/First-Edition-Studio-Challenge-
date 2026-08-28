/* ============================================================
   4. COLOR SCALES
============================================================ */
function lerp(a,b,t){return a+(b-a)*t;}
function hexToRgb(h){h=h.replace('#','');return [parseInt(h.substr(0,2),16),parseInt(h.substr(2,2),16),parseInt(h.substr(4,2),16)];}
function rgbToHex(r,g,b){return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');}
function ramp(hexA,hexB,t){
  const a=hexToRgb(hexA), b=hexToRgb(hexB);
  return rgbToHex(lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t));
}
const RISK_COLORS = {Low:'#3f8f5f',Moderate:'#e0b23e',High:'#e17a34',Severe:'#c23f3f'};
const LANDCOVER_COLORS = {builtup:'#c98a4b', vegetation:'#4f8f5c', bare:'#a89a6b', water:'#3f7fae'};
const LANDCOVER_LABELS = {builtup:'Built-up', vegetation:'Vegetation', bare:'Bare / Agriculture', water:'Water body'};

const FILL_DEFS = {
  dem:        {label:"DEM (Elevation)", unit:"m a.s.l. (norm.)", type:"gradient", lo:'#274b6b', hi:'#dccb84', get:w=>w.elevation, min:"Low",max:"High"},
  slope:      {label:"Slope", unit:"degrees (norm.)", type:"gradient", lo:'#1c2b2f', hi:'#e9ece8', get:w=>w.slope, min:"Flat",max:"Steep"},
  drainageDensity:{label:"Drainage Density", unit:"km/km² (norm.)", type:"gradient", lo:'#0d2c33', hi:'#59d6c4', get:w=>w.drainageDensity, min:"Sparse",max:"Dense"},
  rainfall:   {label:"Rainfall", unit:"annual total (norm.)", type:"gradient", lo:'#12283d', hi:'#5fb0e8', get:w=>w.rainfall, min:"Low",max:"High"},
  buildingDensity:{label:"Building Density", unit:"units/ha (norm.)", type:"gradient", lo:'#241c3a', hi:'#9b7fe0', get:w=>w.buildingDensity, min:"Low",max:"High"},
  population: {label:"Population", unit:"persons (norm.)", type:"gradient", lo:'#2c1030', hi:'#e05fa8', get:w=>w.population, min:"Low",max:"High", raw:w=>w.population},
  landcover:  {label:"Landcover", unit:"class", type:"categorical", get:w=>w.landcover, cats:LANDCOVER_COLORS, labels:LANDCOVER_LABELS},
  risk:       {label:"Risk Map", unit:"class", type:"categorical", get:w=>w.riskClass, cats:RISK_COLORS, labels:{Low:'Low',Moderate:'Moderate',High:'High',Severe:'Severe'}},
  popExposed: {label:"Population Exposed", unit:"persons (norm.)", type:"gradient", lo:'#2a1616', hi:'#e3453b', get:w=>w.popExposed, min:"Low",max:"High", raw:w=>w.popExposed}
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
    return ramp(def.lo, def.hi, t);
  }
  return def.cats[def.get(w)] || '#22343a';
}

/* ============================================================
   5. STATE
============================================================ */
let state = {
  fillLayer:'risk',
  compareLayer:'rainfall',
  compareOn:false,
  swipeX:50,
  selectedWard:null,
  overlays:{ studyArea:false, wardBoundaries:true, roads:false, buildings:false, rivers:false, groundTruth:false },
  opacity:1,
  basemap:'satellite'
};

/* ============================================================
   6. BUILD SIDEBAR CONTROLS
============================================================ */
const GENERAL_LAYERS = [
  {key:'studyArea', label:'Study Area (Boundary)', color:'#f2f2f2'},
  {key:'wardBoundaries', label:'Ward Boundaries', color:'#8fb0ac'},
  {key:'roads', label:'Roads', color:'#c9c2a8'},
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
  const rampCss = def.type==='gradient' ? `linear-gradient(90deg, ${def.lo}, ${def.hi})` : `linear-gradient(90deg, ${Object.values(def.cats).join(',')})`;
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
   7. LEAFLET MAP — wards are a native Leaflet layer (choropleth,
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
// rasters, so they keep the ward-choropleth rendering. Everything else in
// FILL_DEFS is backed by a real raster PNG.
const RASTER_BACKED_KEYS = new Set(['dem','slope','drainageDensity','rainfall','buildingDensity','population','landcover']);
const popExposedLabelsGroup = (typeof L !== 'undefined') ? L.layerGroup() : null;

function toggleLayer(layer, on){
  if(!layer) return;
  if(on && !map.hasLayer(layer)) layer.addTo(map);
  if(!on && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyWardStyle(layer, id){
  const w = wardsById.get(id);
  const isRasterBacked = RASTER_BACKED_KEYS.has(state.fillLayer);
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
  if(!wardsLayer) return; // data not loaded yet

  wardsPane.style.opacity = state.opacity;
  comparePane.style.opacity = state.opacity;

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
      const center = layer.getBounds().getCenter();
      const icon = L.divIcon({ className:'ward-value-label', html: formatCount(w.popExposed), iconSize:[0,0] });
      L.marker(center, { icon, interactive:false, pane:'wardsPane' }).addTo(popExposedLabelsGroup);
    });
  }
  if(!map.hasLayer(popExposedLabelsGroup)) popExposedLabelsGroup.addTo(map);

  // Static image overlays (study area, roads, rivers, buildings) — each
  // toggled independently, same as before, just cheaper to render.
  ['studyArea','roads','rivers','buildings'].forEach((key) => {
    toggleLayer(staticOverlayLayers[key], state.overlays[key]);
  });
  toggleLayer(groundTruthLayerGroup, state.overlays.groundTruth);

  // Raster-backed fill layers (dem/slope/.../landcover): show only the one
  // matching the active fill selection, at the current opacity. risk/
  // popExposed have no raster counterpart and stay ward-choropleth (handled
  // above via applyWardStyle/colorForWard).
  Object.keys(rasterOverlayLayers).forEach((key) => {
    const show = state.fillLayer === key;
    toggleLayer(rasterOverlayLayers[key], show);
    if(show) rasterOverlayLayers[key].setOpacity(state.opacity);
  });
}

/* ============================================================
   8b. HOVER TOOLTIP
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
   8. SWIPE HANDLE
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
   9. LEGEND
============================================================ */
function renderLegend(){
  const def = FILL_DEFS[state.fillLayer];
  const box = document.getElementById('legendBox');
  if(def.type==='gradient'){
    box.innerHTML = `
      <div class="legend-title"><span>${def.label}</span><span class="unit">${def.unit}</span></div>
      <div class="legend-gradient" style="background:linear-gradient(90deg, ${def.lo}, ${def.hi})"></div>
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
   10. STATS PANEL
============================================================ */
function renderStats(){
  const totalPop = wards.reduce((s,w)=>s+w.population,0);
  const highSevere = wards.filter(w=>w.riskClass==='High'||w.riskClass==='Severe');
  const pctHighSevere = Math.round(highSevere.length/wards.length*100);
  const totalExposed = wards.reduce((s,w)=>s+w.popExposed,0);

  document.getElementById('statGrid').innerHTML = `
    <div class="stat-card"><div class="val">${wards.length}</div><div class="lab">Wards mapped</div></div>
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
   11. WARD DETAIL
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
   12. INIT
============================================================ */
async function bootstrap() {
  document.getElementById('mapTitleTag').textContent = 'Loading…';
  try {
    const data = await window.FloodDataAPI.loadRealData();
    wards = data.wards;
    wardsById = new Map(wards.map(w => [w.id, w]));
    wardsGeoJSON = data.wardsGeoJSON;
    computeFillRanges(wards); // must run before any renderMap()/colorForWard() call

    wardsLayer = L.geoJSON(wardsGeoJSON, {
      pane: 'wardsPane',
      style: () => ({ className:'ward-poly', stroke:false, fill:true, fillOpacity:1 }),
      onEachFeature: attachWardEvents,
    }).addTo(map);

    groundTruthLayerGroup = buildGroundTruthLayer(data.groundTruthGeoJSON);

    // Study area / roads / rivers / buildings: pre-rendered PNGs (see
    // generate-static-layers.js), shown as cheap image overlays instead of
    // live vector layers. All four share one bounds rectangle so they
    // register correctly on top of each other and the basemap.
    const staticData = await window.FloodDataAPI.loadStaticLayers();
    const staticBounds = L.latLngBounds(staticData.bounds);
    ['studyArea','roads','rivers','buildings'].forEach((key) => {
      staticOverlayLayers[key] = buildStaticImageLayer(staticData.layers[key], staticBounds);
    });

    // Physical raster layers (dem, slope, drainageDensity, rainfall,
    // buildingDensity, population, landcover): pre-rendered whole-study-area
    // colorized PNGs (see generate-raster-layers.js), shown as the map fill
    // instead of per-ward aggregated colors. Each has its own bounds (the
    // true raster envelope), so build each overlay with its own bounds
    // rather than reusing staticBounds.
    const rasterData = await window.FloodDataAPI.loadRasterOverlays();
    Object.keys(rasterData).forEach((key) => {
      const b = L.latLngBounds(rasterData[key].bounds);
      rasterOverlayLayers[key] = L.imageOverlay(rasterData[key].url, b, {
        pane: 'rasterPane', interactive: false, opacity: state.opacity,
      });
    });

    // Fit the real view to the actual study area instead of the hardcoded
    // default. Uses staticBounds (built from the study area boundary during
    // generation) so the initial zoom always matches the true study extent.
    // paddingBottomRight accounts for the floating right-panel (320px wide,
    // offset 368px in style.css to clear it) which visually covers that
    // portion of the map canvas — without this, fitBounds treats the full
    // canvas width as available space and the study area ends up off-center
    // behind the panel.
    if(staticBounds.isValid()){
      map.fitBounds(staticBounds, {
        paddingTopLeft: [20, 20],
        paddingBottomRight: [340, -20]
      });

      map.once('moveend', () => {
        map.setZoom(map.getZoom() + 0);
      });
    }

    wards.forEach(w => { wardJump.appendChild(new Option(w.name, w.id)); });

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

/* legend collapse toggle */
const mapLegend = document.getElementById('mapLegend');
document.getElementById('legendCollapseBtn').addEventListener('click',e=>{
  e.stopPropagation();
  const collapsed = mapLegend.classList.toggle('collapsed');
  e.target.textContent = collapsed ? '+' : '–';
});