/**
 * Fetches real data from the API and hands back plain GeoJSON, so it can be
 * added directly as native Leaflet layers (L.geoJSON, L.circleMarker).
 *
 * Study area, roads, rivers, and buildings are pre-rendered PNGs (see
 * generate-static-layers.js) and are NOT fetched as GeoJSON here — only
 * wards and ground truth stay interactive/live.
 */

const API_BASE = 'http://localhost:4000/api'; // Express server port — must match server.js app.listen() + app.use() prefix
const STATIC_BASE = 'http://localhost:4000/static/generated'; // served directly by server.js (not through /api)

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                      */
/* ------------------------------------------------------------------ */

async function getJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Cheap centroid for a Polygon/MultiPolygon in lon/lat for ground-truth assignment. */
function lonLatCentroid(geometry) {
  const ring =
    geometry.type === 'Polygon' ? geometry.coordinates[0] :
    geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : null;
  if (!ring || !ring.length) return [0, 0];
  const lon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  return [lon, lat];
}

/* ------------------------------------------------------------------ */
/* Main loader — interactive layers only (wards + ground truth)        */
/* ------------------------------------------------------------------ */

async function loadRealData() {
  // Sequential, not Promise.all — see original note: firing everything at
  // once was pushing Neon's pooled Postgres over its memory limit under
  // concurrent load. With roads/rivers/study-area/buildings now served as
  // pre-rendered PNGs instead of live queries, this list is shorter than
  // before, but kept sequential for the same reason.
  const wardsGeoJSON = await getJSON('/wards');
  const groundTruthGeoJSON = await getJSON('/ground-truth');
  const rasterAll = await getJSON('/raster-all').catch(() => ({})); // Fallback if raster route is loading
  const risk = await getJSON('/risk').catch(() => []);              // Fallback if risk route is loading
  // Catchment summary — wards-mapped count and per-ward population, sourced
  // from gold.grid_cell on Supabase (see server-side routes.js). This is a
  // separate live database from everything else the API queries, so it's
  // fetched independently and falls back gracefully if unreachable.
  const catchmentSummary = await getJSON('/catchment-summary').catch(() => ({
    wardsMapped: null, totalPopulation: null, populationByWard: {},
  }));

  const riskByWard = new Map((risk || []).map((r) => [String(r.ward_id), r]));

  const wards = (wardsGeoJSON.features || []).map((f) => {
    // config.js -> vector.wards.idCol is 'id', so that's the real key
    // routes.js sends back in each feature's properties. Only fall back to
    // the row-number placeholder (_row) if it's ever truly missing.
    const id = String(f.properties.id ?? f.properties._row);
    const name = f.properties.name || f.properties.ward_name || `Ward ${id}`;

    const [lon, lat] = lonLatCentroid(f.geometry);
    const r = riskByWard.get(id) || {};

    // Population now comes from gold.grid_cell (Supabase) per ward, summed
    // server-side in /api/catchment-summary and /api/risk. Falls back to
    // the silver.population raster's zonal sum if a ward has no grid_cell
    // coverage (e.g. catchment-summary fetch failed, or that ward simply
    // isn't present in grid_cell yet), so a ward never silently shows 0
    // population just because one data source is unavailable.
    const gridCellPopulation = catchmentSummary.populationByWard?.[id];
    const population = gridCellPopulation != null
      ? Math.round(gridCellPopulation)
      : Math.round(rasterAll.population?.[id] ?? 0);

    return {
      id,
      name,
      lon, lat,
      elevation: rasterAll.dem?.[id] ?? 0,
      slope: rasterAll.slope?.[id] ?? 0,
      drainageDensity: rasterAll.drainageDensity?.[id] ?? 0,
      buildingDensity: rasterAll.buildingDensity?.[id] ?? 0,
      rainfall: rasterAll.rainfall?.[id] ?? 0,
      population,
      landcover: rasterAll.landcover?.[id] ?? 'bare',
      riskScore: r.riskScore ?? 0,
      riskClass: r.riskClass ?? 'Low',
      popExposed: r.popExposed ?? 0,
      gtPoints: [],
    };
  });

  // Assign ground truth points to nearest ward centroid
  const groundTruthPoints = (groundTruthGeoJSON.features || []).map((f) => ({
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  groundTruthPoints.forEach((pt) => {
    let best = null, bestDist = Infinity;
    wards.forEach((w) => {
      const d = (w.lon - pt.lon) ** 2 + (w.lat - pt.lat) ** 2;
      if (d < bestDist) { bestDist = d; best = w; }
    });
    if (best) best.gtPoints.push(pt);
  });

  // Wards-mapped count for the "Wards mapped" stat card — prefers the
  // grid_cell-derived count (distinct ward_id in gold.grid_cell) per the
  // catchment-summary requirement; falls back to the number of ward
  // polygons actually loaded if catchment-summary is unavailable.
  const wardsMappedCount = catchmentSummary.wardsMapped ?? wards.length;

  return { wards, wardsGeoJSON, groundTruthGeoJSON, wardsMappedCount };
}

/* ------------------------------------------------------------------ */
/* Static (non-interactive) layers — pre-rendered PNGs                 */
/* ------------------------------------------------------------------ */

/**
 * Returns the shared lat/lng bounds and per-layer PNG URLs generated by
 * generate-static-layers.js. All four layers share identical bounds so
 * they stack correctly on the map as independent L.imageOverlay layers.
 */
async function loadStaticLayers() {
  const bounds = await fetch(`${STATIC_BASE}/bounds.json`).then((r) => r.json());
  const latLngBounds = [
    [bounds.minLat, bounds.minLon],
    [bounds.maxLat, bounds.maxLon],
  ];
  return {
    bounds: latLngBounds,
    layers: {
      studyArea: `${STATIC_BASE}/studyArea.png`,
      roads: `${STATIC_BASE}/roads.png`,
      rivers: `${STATIC_BASE}/rivers.png`,
      buildings: `${STATIC_BASE}/buildings.png`,
    },
  };
}

/**
 * Physical raster layers (dem, slope, drainageDensity, rainfall,
 * buildingDensity, population, landcover, floodHazard) — pre-rendered
 * whole-study-area colorized PNGs, see generate-raster-layers.js. Each has
 * its own bounds (the true raster envelope), unlike the static vector
 * layers which all share one bounds rectangle.
 *
 * NOTE: the backend/build script produces this under the key "floodHazard"
 * (matches config.raster.floodHazard / silver.flood_hazard), but the
 * frontend's fill-layer selector calls this layer "risk" (FILL_DEFS.risk,
 * RASTER_BACKED_KEYS in script.js) — rename it here so
 * rasterOverlayLayers.risk resolves to this PNG once state.fillLayer is
 * 'risk'. Every other key passes through unchanged.
 */
async function loadRasterOverlays() {
  const bounds = await fetch(`${STATIC_BASE}/raster/bounds.json`).then((r) => r.json());
  const layers = {};
  Object.keys(bounds).forEach((key) => {
    const b = bounds[key];
    const outKey = key === 'floodHazard' ? 'risk' : key;
    layers[outKey] = {
      url: `${STATIC_BASE}/raster/${key}.png`,
      bounds: [[b.minLat, b.minLon], [b.maxLat, b.maxLon]],
    };
  });
  return layers;
}

window.FloodDataAPI = { loadRealData, loadStaticLayers, loadRasterOverlays };