/**
 * One-time build script: rasterizes the static (non-interactive) vector
 * layers — study area boundary, roads, rivers, buildings — into PNG images
 * so the frontend can display them as cheap Leaflet image overlays instead
 * of thousands of live vector paths (roads alone was ~15MB of GeoJSON).
 *
 * Wards and ground truth are NOT included here — they stay live/interactive
 * (click, hover, choropleth fill) and continue to be fetched as GeoJSON via
 * routes.js / api-data-loader.js as before.
 *
 * Each layer gets its own transparent PNG, all sharing the same geographic
 * bounds, so the frontend can toggle them independently and they still line
 * up correctly on the map.
 *
 * Run manually whenever the underlying data changes:
 *   node generate-static-layers.js
 *
 * Output:
 *   public/generated/<layer>.png   (studyArea, roads, rivers, buildings)
 *   public/generated/bounds.json   { minLon, minLat, maxLon, maxLat, width, height }
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { query } = require('./db');
const config = require('./config');

const OUT_DIR = path.join(__dirname, 'public', 'generated');
const IMG_MAX_DIM = 2200;  // px, longer side of the output images
const PAD_PCT = 0.03;      // 3% padding around the true data extent, so
                            // edge features (e.g. roads at the boundary)
                            // aren't clipped by the image edge

// Layer name -> style + which config.vector entry supplies the geometry.
// Colors match the existing swatches in script.js (GENERAL_LAYERS) so the
// static image looks the same as the vector version it replaces.
const STATIC_LAYERS = {
  studyArea: { vectorKey: 'studyArea', stroke: '#f2f2f2', strokeWidth: 3,   fill: 'none' },
  roads:     { vectorKey: 'roads',     stroke: '#000000', strokeWidth: 1.2, fill: 'none' },
  rivers:    { vectorKey: 'rivers',    stroke: '#4fa9d6', strokeWidth: 2.2, fill: 'none' },
  buildings: { vectorKey: 'buildings', stroke: 'none',    strokeWidth: 0,   fill: '#f4ede1', fillOpacity: 1 },
};

/* ------------------------------------------------------------------ */
/* Fetch geometry (lon/lat, EPSG:4326) straight from Postgres          */
/* ------------------------------------------------------------------ */

async function fetchGeoJSON(vecCfg) {
  const geomExpr = vecCfg.simplify
    ? `ST_Simplify(${vecCfg.geomCol}, ${vecCfg.simplify})`
    : vecCfg.geomCol;
  const sql = `
    SELECT ST_AsGeoJSON(ST_Transform(${geomExpr}, 4326)) AS geojson
    FROM ${vecCfg.table}
    WHERE ${vecCfg.geomCol} IS NOT NULL
  `;
  const { rows } = await query(sql);
  return rows.map((r) => JSON.parse(r.geojson)).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Bounds + simple equirectangular projection (fine at ward scale)     */
/* ------------------------------------------------------------------ */

function walkCoords(geom, fn) {
  const t = geom.type;
  if (t === 'Point') return fn(geom.coordinates);
  if (t === 'MultiPoint' || t === 'LineString') return geom.coordinates.forEach(fn);
  if (t === 'MultiLineString' || t === 'Polygon') return geom.coordinates.forEach((ring) => ring.forEach(fn));
  if (t === 'MultiPolygon') return geom.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(fn)));
}

function computeBounds(geoms) {
  const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  geoms.forEach((g) => walkCoords(g, ([lon, lat]) => {
    b.minLon = Math.min(b.minLon, lon); b.maxLon = Math.max(b.maxLon, lon);
    b.minLat = Math.min(b.minLat, lat); b.maxLat = Math.max(b.maxLat, lat);
  }));
  const padLon = (b.maxLon - b.minLon) * PAD_PCT || 0.01;
  const padLat = (b.maxLat - b.minLat) * PAD_PCT || 0.01;
  return {
    minLon: b.minLon - padLon, maxLon: b.maxLon + padLon,
    minLat: b.minLat - padLat, maxLat: b.maxLat + padLat,
  };
}

function makeProjector(bounds, width, height) {
  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;
  return ([lon, lat]) => [
    ((lon - bounds.minLon) / lonSpan) * width,
    height - ((lat - bounds.minLat) / latSpan) * height, // flip Y: lat grows up, SVG grows down
  ];
}

/* ------------------------------------------------------------------ */
/* GeoJSON -> SVG path data                                            */
/* ------------------------------------------------------------------ */

function geomToSvgPath(geom, project) {
  const ring = (coords) => coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${project(c).join(',')}`).join(' ') + ' Z';
  const line = (coords) => coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${project(c).join(',')}`).join(' ');

  if (geom.type === 'LineString') return line(geom.coordinates);
  if (geom.type === 'MultiLineString') return geom.coordinates.map(line).join(' ');
  if (geom.type === 'Polygon') return geom.coordinates.map(ring).join(' ');
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((poly) => poly.map(ring).join(' ')).join(' ');
  return '';
}

async function renderLayer(name, style, geoms, bounds, width, height) {
  const project = makeProjector(bounds, width, height);
  const paths = geoms
    .map((g) => geomToSvgPath(g, project))
    .filter(Boolean)
    .map((d) => `<path d="${d}" />`)
    .join('\n');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <g fill="${style.fill}" fill-opacity="${style.fillOpacity ?? 1}"
         stroke="${style.stroke}" stroke-width="${style.strokeWidth}"
         stroke-linejoin="round" stroke-linecap="round">
        ${paths}
      </g>
    </svg>`;

  const outPath = path.join(OUT_DIR, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`Wrote ${outPath}  (${geoms.length} features)`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Pull every layer's geometry once, already in lon/lat.
  const layerGeoms = {};
  for (const [name, style] of Object.entries(STATIC_LAYERS)) {
    const vecCfg = config.vector[style.vectorKey];
    if (!vecCfg) throw new Error(`config.vector.${style.vectorKey} is not defined`);
    layerGeoms[name] = await fetchGeoJSON(vecCfg);
  }

  // 2. Shared bounds across ALL layers so every PNG lines up on the map —
  // anchored on the study area boundary, the authoritative extent (same
  // source the old fitBounds() call used).
  const anchorGeoms = layerGeoms.studyArea.length ? layerGeoms.studyArea : Object.values(layerGeoms).flat();
  const bounds = computeBounds(anchorGeoms);

  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;
  const width = lonSpan >= latSpan ? IMG_MAX_DIM : Math.round(IMG_MAX_DIM * (lonSpan / latSpan));
  const height = lonSpan >= latSpan ? Math.round(IMG_MAX_DIM * (latSpan / lonSpan)) : IMG_MAX_DIM;

  // 3. Render each layer to its own transparent PNG, same bounds/size, so
  // the frontend can toggle each one independently as a separate overlay.
  for (const [name, style] of Object.entries(STATIC_LAYERS)) {
    await renderLayer(name, style, layerGeoms[name], bounds, width, height);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'bounds.json'),
    JSON.stringify({ ...bounds, width, height }, null, 2)
  );
  console.log('Bounds written:', bounds);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
