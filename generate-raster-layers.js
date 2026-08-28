/**
 * One-time build script: renders each physical raster layer (dem, slope,
 * drainageDensity, rainfall, buildingDensity, population, landcover) as a
 * single colorized PNG covering the whole study area.
 *
 * IMPORTANT: this deliberately avoids ST_AsPNG / ST_ColorMap / raster
 * ST_Transform, because those route through PostGIS's GDAL raster-export
 * drivers (rt_raster_to_gdal), which many managed Postgres providers
 * (Neon included) disable server-side — you'll get "Could not load the
 * output GDAL driver" and there is usually no way to enable it yourself.
 * Instead we pull raw pixel values with ST_DumpValues (plain array data,
 * no GDAL export involved) and do the colorizing + PNG encoding here in
 * Node with `sharp`.
 *
 * "Computed" layers that are ward-level model outputs rather than physical
 * rasters (risk score, population exposed) are NOT included — they stay as
 * ward choropleth fills using zonalStats.js as before.
 *
 * Run manually whenever the underlying raster data changes:
 *   node generate-raster-layers.js
 *
 * Output:
 *   public/generated/raster/<layer>.png
 *   public/generated/raster/bounds.json   { <layer>: {minLon,minLat,maxLon,maxLat} }
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { query } = require('./db');
const config = require('./config');

const OUT_DIR = path.join(__dirname, 'public', 'generated', 'raster');

// Continuous layers: multi-stop color ramp (stretched-min value -> first
// stop, stretched-max value -> last stop), matched to FILL_DEFS.stops in
// script.js. Keep these in sync if you change the palette there.
// NOTE: no leading '#' on these — hexToRgb() below expects bare hex.
const CONTINUOUS_RAMPS = {
  dem:             ['f5e6c8', 'd8c28f', 'a6b86a', '5f8f5b', '3d6f62', '274b6b'],
  slope:           ['f7f7f7', 'd9ead3', 'b6d7a8', 'f6d365', 'e89b3c', 'a85d2a', '663c24'],
  drainageDensity: ['f1fbfa', 'c7eeeb', '8bd8d2', '4fbdb7', '159a9c', '087f8c', '064c59'],
  rainfall:        ['f7fcff', 'd9f0ff', 'a6d8f5', '5fb0e8', '2171b5', '08519c', '08306b'],
  buildingDensity: ['faf7ff', 'e4d9f5', 'c7b5e3', '9b7fe0', '7552b5', '54278f', '32145f'],
  population:      ['fff5f9', 'fde0ec', 'f7b6d2', 'e76f9f', 'c43d7a', 'a50f6b', '6a0055'],
};

// Percentile cutoffs used to stretch continuous layers' contrast. Using the
// 2nd/98th percentile instead of raw min/max does two things:
//   1. If the true data range is very narrow (e.g. rainfall varying by only
//      a fraction of a percent across the study area), it still stretches
//      that narrow range across the full color ramp instead of collapsing
//      to a single flat color.
//   2. It prevents a handful of outlier pixels from compressing everything
//      else into one end of the ramp.
const STRETCH_LOW_PCT = 2;
const STRETCH_HIGH_PCT = 98;

// Landcover (categorical): category name -> hex color. Keep in sync with
// LANDCOVER_COLORS in script.js. Raw pixel value -> category name comes
// from config.landcoverClassMap; any raw value NOT found there gets an
// auto-assigned fallback color (see writeLandcoverPNG) instead of being
// left blank/transparent.
// NOTE: no leading '#' — hexToRgb() below expects bare hex.
const LANDCOVER_COLORS = {
  water:     '3f82b5',
  trees:     '3f8f5b',
  grassland: '78a85a',
  cropland:  'b6a94a',
  shrubland: '8b9d55',
  builtup:   'c96b3c',
  bare:      'c8b27a',
  wetlands:  '5b9e8c',
  snow:      'e8edf0',
};
const AUTO_FALLBACK_PALETTE = ['e07a5f', '81b29a', 'f2cc8f', '3d5a80', '9b5de5', 'ef8354', '6d6875'];

function hexToRgb(hex) {
  return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
}
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Multi-stop ramp interpolation: t in [0,1] is mapped onto the (n-1)
 * segments between n hex color stops, then linearly interpolated within
 * whichever segment it falls into. With 2 stops this behaves identically
 * to the old 2-color lerp, so it's a drop-in replacement.
 */
function colorAtStop(hexStops, t) {
  const n = hexStops.length - 1;
  const scaled = Math.max(0, Math.min(1, t)) * n;
  const idx = Math.min(Math.floor(scaled), n - 1);
  const localT = scaled - idx;
  const [r1, g1, b1] = hexToRgb(hexStops[idx]);
  const [r2, g2, b2] = hexToRgb(hexStops[idx + 1]);
  return [lerp(r1, r2, localT), lerp(g1, g2, localT), lerp(b1, b2, localT)];
}

/* ------------------------------------------------------------------ */
/* Pull merged raster's raw pixels + geographic bounds                 */
/* No GDAL-dependent functions here — ST_Union/ST_DumpValues/          */
/* ST_SummaryStats are pure raster-algebra, and the bounds come from    */
/* transforming the ENVELOPE (a plain polygon geometry) to 4326, which  */
/* uses PostGIS's normal PROJ-based geometry transform, not raster GDAL. */
/* ------------------------------------------------------------------ */

async function fetchRasterData(layerCfg) {
  const studyCfg = config.vector.studyArea;
  const sql = `
    WITH merged AS (
      SELECT ST_Union(${layerCfg.rastCol}, ${layerCfg.band}) AS rast
      FROM ${layerCfg.table}
    ),
    boundary AS (
      SELECT ST_Union(${studyCfg.geomCol}) AS geom
      FROM ${studyCfg.table}
    ),
    clipped AS (
      -- Clip to the ACTUAL study area polygon (not just its bounding box):
      -- ST_Clip nodata's out every pixel outside the geometry, and crop=true
      -- also shrinks the raster canvas to the geometry's extent, so we're
      -- not carrying padding/other tiles that skew the min/max used for
      -- the color ramp.
      SELECT ST_Clip(m.rast, ST_Transform(b.geom, ST_SRID(m.rast)), true) AS rast
      FROM merged m, boundary b
    )
    SELECT
      ST_Width(rast) AS width,
      ST_Height(rast) AS height,
      (ST_SummaryStats(rast, 1)).min AS mn,
      (ST_SummaryStats(rast, 1)).max AS mx,
      ST_DumpValues(rast, 1) AS pixels,
      ST_AsGeoJSON(ST_Transform(ST_Envelope(rast), 4326)) AS envelope
    FROM clipped;
  `;
  const { rows } = await query(sql);
  if (!rows.length) return null;
  const row = rows[0];
  const envelope = JSON.parse(row.envelope);
  const coords = envelope.coordinates[0];
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return {
    width: row.width,
    height: row.height,
    min: row.mn,
    max: row.mx,
    pixels: row.pixels, // 2D array [row][col], row-major, top row first
    bounds: {
      minLon: Math.min(...lons), maxLon: Math.max(...lons),
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Percentile-based contrast stretch for continuous layers             */
/* ------------------------------------------------------------------ */

/**
 * Returns { lo, hi } stretch bounds from the actual pixel distribution,
 * instead of raw min/max. Falls back gracefully if the raster is (close
 * to) perfectly flat, so a genuinely constant layer still renders as a
 * visible flat tone rather than producing a divide-by-zero-flavored bug.
 */
function computeStretchBounds(pixels, lowPct = STRETCH_LOW_PCT, highPct = STRETCH_HIGH_PCT) {
  const flat = [];
  for (const row of pixels) {
    for (const v of row) {
      if (v !== null && v !== undefined) flat.push(v);
    }
  }
  if (!flat.length) return { lo: 0, hi: 1 };
  flat.sort((a, b) => a - b);

  const loIdx = Math.floor((flat.length - 1) * (lowPct / 100));
  const hiIdx = Math.ceil((flat.length - 1) * (highPct / 100));
  let lo = flat[loIdx];
  let hi = flat[hiIdx];

  if (hi - lo <= 0) {
    // Raster is effectively constant even after stretching — synthesize a
    // small artificial span around the single value so it still renders
    // as a solid, visible mid-ramp color instead of NaN/blank.
    const mid = flat[Math.floor(flat.length / 2)];
    const pad = Math.abs(mid) * 0.01 || 0.5;
    lo = mid - pad;
    hi = mid + pad;
  }
  return { lo, hi };
}

/* ------------------------------------------------------------------ */
/* Colorize in Node and encode with sharp                              */
/* ------------------------------------------------------------------ */

async function writeContinuousPNG(key, data, outPath) {
  const stops = CONTINUOUS_RAMPS[key];
  const { width, height, pixels } = data;

  // Stretched bounds drive the color ramp; data.min/data.max (raw
  // ST_SummaryStats values) are kept only for the console diagnostics below.
  const { lo, hi } = computeStretchBounds(pixels);
  const span = hi - lo || 1;

  console.log(
    `  ${key}: raw min/max = ${data.min?.toFixed?.(4) ?? data.min} / ${data.max?.toFixed?.(4) ?? data.max}` +
    `  |  stretch (p${STRETCH_LOW_PCT}-p${STRETCH_HIGH_PCT}) = ${lo.toFixed(4)} / ${hi.toFixed(4)}`
  );
  if ((data.max - data.min) !== 0 && (data.max - data.min) < (Math.abs(data.max) * 0.01)) {
    console.log(
      `  ${key}: NOTE — raw range is very narrow relative to magnitude (looked flat before). ` +
      `Now stretched using the ${STRETCH_LOW_PCT}-${STRETCH_HIGH_PCT} percentile range so contrast is visible.`
    );
  }

  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixels[y] || [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = row[x];
      if (v === null || v === undefined) continue; // stays fully transparent (alpha 0)
      const t = Math.max(0, Math.min(1, (v - lo) / span));
      const [r, g, b] = colorAtStop(stops, t);
      buffer[idx] = Math.round(r);
      buffer[idx + 1] = Math.round(g);
      buffer[idx + 2] = Math.round(b);
      buffer[idx + 3] = 255;
    }
  }
  await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
}

async function writeLandcoverPNG(data, outPath) {
  const { width, height, pixels } = data;

  // 1. Find every distinct raw pixel value actually present in the raster.
  const distinctRaw = new Set();
  for (const row of pixels) {
    for (const v of row) {
      if (v !== null && v !== undefined) distinctRaw.add(Math.round(v));
    }
  }
  const distinctList = [...distinctRaw].sort((a, b) => a - b);

  // 2. Build a raw-value -> RGB lookup. Prefer config.landcoverClassMap
  // where a code is recognized; otherwise auto-assign a fallback color so
  // the layer is never left blank.
  const colorByRawValue = {};
  const unmapped = [];
  distinctList.forEach((rawValue, i) => {
    const className = config.landcoverClassMap[rawValue];
    if (className && LANDCOVER_COLORS[className]) {
      colorByRawValue[rawValue] = hexToRgb(LANDCOVER_COLORS[className]);
    } else {
      unmapped.push(rawValue);
      colorByRawValue[rawValue] = hexToRgb(AUTO_FALLBACK_PALETTE[i % AUTO_FALLBACK_PALETTE.length]);
    }
  });

  console.log(`  landcover: distinct raw pixel values found: ${distinctList.join(', ') || '(none)'}`);
  if (unmapped.length) {
    console.warn(
      `  landcover: ${unmapped.length} raw value(s) not found in config.landcoverClassMap: ${unmapped.join(', ')}. ` +
      `Auto-assigning fallback colors so the layer isn't blank. ` +
      `Update landcoverClassMap in config.js with these codes (see comment there) for correct category names/colors.`
    );
  } else if (distinctList.length) {
    console.log(`  landcover: all raw values matched config.landcoverClassMap.`);
  }

  // 3. Paint.
  let seen = 0, painted = 0;
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixels[y] || [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = row[x];
      if (v === null || v === undefined) continue; // transparent
      seen++;
      const rgb = colorByRawValue[Math.round(v)];
      if (!rgb) continue; // should not happen now, but keep as a safety net
      painted++;
      buffer[idx] = rgb[0]; buffer[idx + 1] = rgb[1]; buffer[idx + 2] = rgb[2]; buffer[idx + 3] = 255;
    }
  }
  console.log(`  landcover: painted ${painted}/${seen} non-null pixels.`);
  await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bounds = {};

  for (const key of Object.keys(config.raster)) {
    const layerCfg = config.raster[key];
    console.log(`Fetching ${key}...`);
    const data = await fetchRasterData(layerCfg);
    if (!data) { console.warn(`No raster data for "${key}" — skipping`); continue; }

    const outPath = path.join(OUT_DIR, `${key}.png`);
    if (layerCfg.stat === 'mode') {
      await writeLandcoverPNG(data, outPath);
    } else {
      await writeContinuousPNG(key, data, outPath);
    }
    bounds[key] = data.bounds;
    console.log(`Wrote ${key}.png  (${data.width}x${data.height})`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'bounds.json'), JSON.stringify(bounds, null, 2));
  console.log('Raster bounds written:', bounds);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });