const express = require('express');
const { query } = require('./db');
const config = require('./config');
const { zonalStatsForLayer, normalize } = require('./zonalStats');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Vector layers — straight GeoJSON passthrough                        */
/* ------------------------------------------------------------------ */

function vectorFeatureCollectionSQL({ table, geomCol, extraCols = [], srid, where = '', simplify = null }) {
  const cols = extraCols.length ? extraCols.map((c) => `'${c}', ${c}`).join(', ') + ', ' : '';
  // Simplify before transforming/serializing when a tolerance is given
  // (roads currently) — cuts payload size and Postgres memory needed to
  // build the response, with no visible effect at normal map zoom levels.
  const geomExpr = simplify
    ? `ST_Simplify(${geomCol}, ${simplify})`
    : geomCol;
  return `
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
    ) AS geojson
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Transform(${geomExpr}, ${srid}))::jsonb,
        'properties', jsonb_build_object(${cols} '_row', row_number() OVER ())
      ) AS feature
      FROM ${table}
      ${where}
    ) f;
  `;
}

router.get('/study-area', async (req, res, next) => {
  try {
    const l = config.vector.studyArea;
    const { rows } = await query(
      vectorFeatureCollectionSQL({ table: l.table, geomCol: l.geomCol, srid: config.targetSRID })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

router.get('/wards', async (req, res, next) => {
  try {
    const l = config.vector.wards;
    const { rows } = await query(
      vectorFeatureCollectionSQL({
        table: l.table,
        geomCol: l.geomCol,
        extraCols: [l.idCol, l.nameCol], // Pass ['id', 'ward_name']
        srid: config.targetSRID,
      })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

router.get('/roads', async (req, res, next) => {
  try {
    const l = config.vector.roads;
    const { rows } = await query(
      vectorFeatureCollectionSQL({
        table: l.table,
        geomCol: l.geomCol,
        extraCols: [l.classCol],
        srid: config.targetSRID,
        simplify: l.simplify, // undefined for every other layer — no change to them
      })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

// Buildings can be huge — require a bbox (minLon,minLat,maxLon,maxLat) so the
// frontend only pulls what's in view. Falls back to a hard LIMIT otherwise.
router.get('/buildings', async (req, res, next) => {
  try {
    const l = config.vector.buildings;
    const { bbox } = req.query;
    let where = '';
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      where = `WHERE ST_Intersects(
        ${l.geomCol},
        ST_Transform(ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326), ST_SRID(${l.geomCol}))
      )`;
    } else {
      where = 'ORDER BY random() LIMIT 3000'; // safety valve for "so many" buildings
    }
    const { rows } = await query(
      vectorFeatureCollectionSQL({ table: l.table, geomCol: l.geomCol, srid: config.targetSRID, where })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

router.get('/rivers', async (req, res, next) => {
  try {
    const l = config.vector.rivers;
    const { rows } = await query(
      vectorFeatureCollectionSQL({ table: l.table, geomCol: l.geomCol, srid: config.targetSRID })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

router.get('/ground-truth', async (req, res, next) => {
  try {
    const l = config.vector.groundTruth;
    const { rows } = await query(
      vectorFeatureCollectionSQL({ table: l.table, geomCol: l.geomCol, srid: config.targetSRID })
    );
    res.json(rows[0].geojson);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Raster layers — zonal stats per ward                                */
/* ------------------------------------------------------------------ */

const RASTER_KEYS = Object.keys(config.raster);

router.get('/raster/:layer', async (req, res, next) => {
  try {
    const { layer } = req.params;
    if (!RASTER_KEYS.includes(layer)) {
      return res.status(404).json({ error: `Unknown layer. Valid: ${RASTER_KEYS.join(', ')}` });
    }
    const stats = await zonalStatsForLayer(layer);
    res.json(Object.fromEntries(stats)); // { ward_id: value, ... }
  } catch (err) { next(err); }
});

// All raster layers in one call — the frontend needs this on load anyway,
// and fetching them in parallel server-side is much faster than N round trips.
router.get('/raster-all', async (req, res, next) => {
  try {
    const entries = await Promise.all(
      RASTER_KEYS.map(async (key) => [key, Object.fromEntries(await zonalStatsForLayer(key))])
    );
    res.json(Object.fromEntries(entries));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Computed layers — risk score & population exposed                   */
/* Not in the DB yet, so we derive them here from the raster zonal      */
/* stats using the same weighting the original synthetic model used.   */
/* ------------------------------------------------------------------ */

router.get('/risk', async (req, res, next) => {
  try {
    const [rainfall, drainage, dem, slope, buildingDensity, population] = await Promise.all(
      ['rainfall', 'drainageDensity', 'dem', 'slope', 'buildingDensity', 'population'].map(zonalStatsForLayer)
    );
    const rainfallN = normalize(rainfall);
    const drainageN = normalize(drainage);
    const elevN = normalize(dem);       // higher = higher elevation
    const slopeN = normalize(slope);
    const densityN = normalize(buildingDensity);
    const w = config.riskWeights;

    const wardIds = [...rainfallN.keys()];
    const riskScores = new Map();
    wardIds.forEach((id) => {
      const score =
        (rainfallN.get(id) ?? 0.5) * w.rainfall +
        (drainageN.get(id) ?? 0.5) * w.drainageDensity +
        (1 - (elevN.get(id) ?? 0.5)) * w.inverseElevation +
        (1 - (slopeN.get(id) ?? 0.5)) * w.inverseSlope +
        (densityN.get(id) ?? 0.5) * w.buildingDensity;
      riskScores.set(id, Math.max(0, Math.min(1, score)));
    });

    // Quantile risk class, same as the original: bottom 25% Low, next 30%
    // Moderate, next 25% High, top 20% Severe.
    const sorted = [...riskScores.entries()].sort((a, b) => a[1] - b[1]);
    const n = sorted.length;
    const classes = new Map();
    sorted.forEach(([id], i) => {
      const q = i / n;
      classes.set(id, q < 0.25 ? 'Low' : q < 0.55 ? 'Moderate' : q < 0.8 ? 'High' : 'Severe');
    });

    const out = wardIds.map((id) => ({
      ward_id: id,
      riskScore: riskScores.get(id),
      riskClass: classes.get(id),
      population: population.get(id) ?? 0,
      popExposed: Math.round((population.get(id) ?? 0) * riskScores.get(id)),
    }));
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;