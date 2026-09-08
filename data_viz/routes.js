const express = require('express');
const { query } = require('./db');
const { query: supabaseQuery } = require('./supabaseDb');
const config = require('./config');
const { zonalStatsForLayer } = require('./zonalStats');

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
/* grid_cell has no risk fields populated (risk_category_id/risk_score  */
/* are null across every row as of this writing), so it's used ONLY as  */
/* the population source here — population per ward, summed across all  */
/* grid cells whose ward_id matches. Risk still comes from flood_hazard */
/* below. Nulls in grid_cell.population (uninhabited cells — water,     */
/* bare ground, etc.) are treated as 0 via COALESCE/SUM's natural       */
/* null-skipping behavior.                                               */
/* ------------------------------------------------------------------ */

/** silver.boundaries.id (string) -> ward_name */
async function getWardNameById() {
  const wards = config.vector.wards;
  const sql = `SELECT ${wards.idCol} AS id, ${wards.nameCol} AS name FROM ${wards.table}`;
  const { rows } = await query(sql);
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

/** gold.lu_ward.ward_name -> summed population from gold.grid_cell */
async function getPopulationByWardName() {
  const sql = `
    SELECT lw.ward_name, COALESCE(SUM(gc.population), 0) AS population
    FROM gold.grid_cell gc
    JOIN gold.lu_ward lw ON lw.id = gc.ward_id
    WHERE gc.ward_id IS NOT NULL
    GROUP BY lw.ward_name
  `;
  const { rows } = await supabaseQuery(sql);
  return new Map(rows.map((r) => [r.ward_name, Number(r.population)]));
}

/**
 * Returns Map<String(silver.boundaries.id), population>, bridging the two
 * database's ID schemes via ward name (see comment block above). Wards
 * present in silver.boundaries but with no matching name on the Supabase
 * side get population 0 rather than being silently dropped, so every
 * ward the frontend knows about still gets an entry.
 */
async function getPopulationByWard() {
  const [nameById, populationByName] = await Promise.all([
    getWardNameById(),
    getPopulationByWardName(),
  ]);

  const result = new Map();
  const unmatched = [];
  nameById.forEach((name, id) => {
    if (populationByName.has(name)) {
      result.set(id, populationByName.get(name));
    } else {
      result.set(id, 0);
      unmatched.push(name);
    }
  });

  if (unmatched.length) {
    console.warn(
      `[getPopulationByWard] ${unmatched.length} ward(s) in ${config.vector.wards.table} had no ` +
      `name match in gold.lu_ward, population defaulted to 0: ${unmatched.join(', ')}`
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
/* Risk score/class derive from silver.flood_hazard (a raster of        */
/* integer severity classes 0-4 — see class_scheme on that table).      */
/* Each ward's mean severity is normalized against the raster's known    */
/* 0-4 range, then wards are bucketed into Low/Moderate/High/Severe by   */
/* the 25/30/25/20% quantile split in config.riskQuantiles. Population   */
/* (and therefore population exposed) comes from gold.grid_cell on       */
/* Supabase via getPopulationByWard() above, which already returns a     */
/* Map keyed by silver.boundaries id (bridged through ward name), so no  */
/* further id translation is needed here — both hazardMean (from         */
/* zonalStatsForLayer, keyed by silver.boundaries id) and                */
/* populationByWard now share the same id space.                         */
/* ------------------------------------------------------------------ */

router.get('/risk', async (req, res, next) => {
  try {
    const [hazardMean, populationByWard] = await Promise.all([
      zonalStatsForLayer('floodHazard'),
      getPopulationByWard(),
    ]);

    const { min: hazardMin, max: hazardMax } = config.floodHazardRange;
    const hazardSpan = hazardMax - hazardMin || 1;

    const riskScores = new Map();
    hazardMean.forEach((meanVal, wardId) => {
      const id = String(wardId); // normalize to match populationByWard's string keys
      const t = (meanVal - hazardMin) / hazardSpan;
      riskScores.set(id, Math.max(0, Math.min(1, t)));
    });

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
      const population = populationByWard.get(id) ?? 0;
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