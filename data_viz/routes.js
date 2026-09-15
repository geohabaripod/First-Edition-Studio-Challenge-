const express = require('express');
const { query } = require('./db');
const { query: supabaseQuery } = require('./supabaseDb');
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
/* Population by ward — Supabase (gold.grid_cell)                      */
/*                                                                      */
/* IMPORTANT — two unrelated ID schemes:                                */
/* silver.boundaries.id (LOCAL Postgres, e.g. 35-51) and                */
/* gold.grid_cell.ward_id (SUPABASE, e.g. 1-17) are NOT the same ID     */
/* space. gold.grid_cell.ward_id actually references gold.lu_ward.id,   */
/* not silver.boundaries.id — confirmed by diagnostics: silver has 17   */
/* wards numbered 35-51, gold.grid_cell has 17 distinct ward_id values  */
/* numbered 1-17 that resolve via gold.lu_ward to the SAME 17 ward      */
/* names. Comparing/joining the two id sets directly (even after        */
/* String()-normalizing both to fix a number-vs-string mismatch) will   */
/* silently produce zero matches, because the numbers themselves never  */
/* overlap — String() alone does not fix a wrong-ID-space join.         */
/*                                                                      */
/* The only reliable bridge between the two systems is ward NAME        */
/* (silver.boundaries.ward_name <-> gold.lu_ward.ward_name). This       */
/* function does that join once and returns a Map keyed by              */
/* silver.boundaries.id (as a string) — the same id space the frontend  */
/* /wards GeoJSON and everything else in this file already use — so     */
/* every caller (getPopulationByWard's consumers below) can keep        */
/* treating "ward id" as the silver.boundaries id without knowing       */
/* about the Supabase side at all.                                      */
/*                                                                      */
/* NAME MATCHING IS NORMALIZED (trim + lowercase + collapse internal    */
/* whitespace) via normalizeWardName() below, rather than comparing raw */
/* strings. The two databases can disagree on case or spacing ("Kasarani */
/* " vs "kasarani") for what is otherwise the same ward, and a raw      */
/* string comparison would silently treat those as non-matches, sending */
/* every affected ward's population — and therefore its computed        */
/* popExposed in /risk below — to 0. If a ward is STILL unmatched after */
/* normalization, that means the names genuinely differ (e.g. an        */
/* abbreviation or a renamed ward), which needs an explicit alias        */
/* mapping rather than more normalization.                              */
/*                                                                      */
/* grid_cell has no risk fields populated (risk_category_id/risk_score  */
/* are null across every row as of this writing), so it's used ONLY as  */
/* the population source here — population per ward, summed across all  */
/* grid cells whose ward_id matches. Risk comes from flood_hazard below. */
/* Nulls in grid_cell.population (uninhabited cells — water, bare        */
/* ground, etc.) are treated as 0 via COALESCE/SUM's natural null-       */
/* skipping behavior.                                                    */
/* ------------------------------------------------------------------ */

/** Normalizes a ward name for cross-database matching: trims, lowercases,
 * and collapses internal whitespace runs to a single space. Both sides of
 * the join (silver.boundaries.ward_name and gold.lu_ward.ward_name) get
 * run through this before comparing, so "Kasarani ", "kasarani", and
 * "Kasarani" all match even though they're not byte-identical. */
function normalizeWardName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** silver.boundaries.id (string) -> ward_name */
async function getWardNameById() {
  const wards = config.vector.wards;
  const sql = `SELECT ${wards.idCol} AS id, ${wards.nameCol} AS name FROM ${wards.table}`;
  const { rows } = await query(sql);
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

/** normalized ward_name -> summed population from gold.grid_cell */
async function getPopulationByWardName() {
  const sql = `
    SELECT lw.ward_name, COALESCE(SUM(gc.population), 0) AS population
    FROM gold.grid_cell gc
    JOIN gold.lu_ward lw ON lw.id = gc.ward_id
    WHERE gc.ward_id IS NOT NULL
    GROUP BY lw.ward_name
  `;
  const { rows } = await supabaseQuery(sql);
  const map = new Map();
  rows.forEach((r) => {
    map.set(normalizeWardName(r.ward_name), Number(r.population));
  });
  return map;
}

/**
 * Returns Map<String(silver.boundaries.id), population>, bridging the two
 * database's ID schemes via NORMALIZED ward name (see normalizeWardName
 * and the comment block above). Wards present in silver.boundaries but
 * with no matching normalized name on the Supabase side get population 0
 * rather than being silently dropped, so every ward the frontend knows
 * about still gets an entry.
 */
async function getPopulationByWard() {
  const [nameById, populationByName] = await Promise.all([
    getWardNameById(),
    getPopulationByWardName(),
  ]);

  const result = new Map();
  const unmatched = [];
  nameById.forEach((name, id) => {
    const key = normalizeWardName(name);
    if (populationByName.has(key)) {
      result.set(id, populationByName.get(key));
    } else {
      result.set(id, 0);
      unmatched.push(name);
    }
  });

  if (unmatched.length) {
    console.warn(
      `[getPopulationByWard] ${unmatched.length} ward(s) in ${config.vector.wards.table} had no ` +
      `normalized name match in gold.lu_ward, population defaulted to 0: ${unmatched.join(', ')}`
    );
  }

  return result;
}

router.get('/catchment-summary', async (req, res, next) => {
  try {
    const populationByWard = await getPopulationByWard();
    const totalPopulation = [...populationByWard.values()].reduce((sum, v) => sum + v, 0);
    res.json({
      wardsMapped: populationByWard.size,
      totalPopulation,
      populationByWard: Object.fromEntries(populationByWard),
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Computed layer — risk score & population exposed                    */
/*                                                                      */
/* CHANGED: risk now derives from the silver.flood_hazard raster        */
/* (config.raster.floodHazard) instead of the old five-raster weighted  */
/* blend (rainfall/drainageDensity/dem/slope/buildingDensity via        */
/* config.riskWeights). That config key no longer exists — config.js    */
/* now ships floodHazardRange (the raster's fixed 0-4 severity scale)   */
/* and riskQuantiles (the Low/Moderate/High/Severe cutoffs) instead,    */
/* per the comments on config.raster.floodHazard. This route previously */
/* still referenced the removed config.riskWeights, which is why it     */
/* 500'd with "Cannot read properties of undefined (reading 'rainfall')" */
/* — w was undefined.                                                    */
/*                                                                      */
/* Population source is unchanged: gold.grid_cell via getPopulationByWard() */
/* above, keyed by String(silver.boundaries.id).                        */
/* ------------------------------------------------------------------ */

router.get('/risk', async (req, res, next) => {
  try {
    const [hazard, populationByWard] = await Promise.all([
      zonalStatsForLayer('floodHazard'),
      getPopulationByWard(),
    ]);

    // Normalize each ward's mean severity (0-4 fixed scale, not min/max
    // across wards — see config.floodHazardRange comment) to 0..1.
    const { min, max } = config.floodHazardRange;
    const riskScores = new Map();
    hazard.forEach((value, id) => {
      const t = (value - min) / (max - min);
      riskScores.set(id, Math.max(0, Math.min(1, t)));
    });

    // Quantile risk class from config.riskQuantiles (bottom `low` -> Low,
    // next up to `moderate` -> Moderate, next up to `high` -> High, rest
    // -> Severe), applied to wards ranked by risk score lowest to highest.
    const { low, moderate, high } = config.riskQuantiles;
    const sorted = [...riskScores.entries()].sort((a, b) => a[1] - b[1]);
    const n = sorted.length;
    const classes = new Map();
    sorted.forEach(([id], i) => {
      const q = i / n;
      classes.set(id, q < low ? 'Low' : q < moderate ? 'Moderate' : q < high ? 'High' : 'Severe');
    });

    const wardIds = [...riskScores.keys()];
    const out = wardIds.map((id) => {
      const population = populationByWard.get(String(id)) ?? 0;
      const riskScore = riskScores.get(id);
      return {
        ward_id: id,
        riskScore,
        riskClass: classes.get(id),
        population,
        popExposed: Math.round(population * riskScore),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;