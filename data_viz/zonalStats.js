const { query } = require('./db');
const config = require('./config');

/**
 * Computes one value per ward for a raster layer.
 *
 * Rasters are often stored as multiple tiled rows per coverage, so we clip
 * each intersecting tile to the ward polygon and aggregate across tiles with
 * ST_SummaryStatsAgg (for mean/sum/min/max) or ST_ValueCount (for the
 * majority class, used by land cover).
 *
 * @param {string} layerKey - key into config.raster (e.g. 'dem')
 * @returns {Promise<Map<string, number|string>>} ward_id -> value
 */
async function zonalStatsForLayer(layerKey) {
  const layer = config.raster[layerKey];
  if (!layer) throw new Error(`Unknown raster layer "${layerKey}"`);
  const wards = config.vector.wards;

  if (layer.stat === 'mode') {
    return zonalMode(layer, wards);
  }
  return zonalSummary(layer, wards);
}

async function zonalSummary(layer, wards) {
  // ST_SummaryStatsAgg aggregates SummaryStats across the grouped rows,
  // which correctly handles a raster coverage split into multiple tiles.
  const aggFn =
    layer.stat === 'sum' ? 'sum' :
    layer.stat === 'min' ? 'min' :
    layer.stat === 'max' ? 'max' : 'mean';

  const sql = `
    SELECT w.${wards.idCol} AS ward_id,
           (ST_SummaryStatsAgg(clipped.rast, ${layer.band}, true)).${aggFn} AS value
    FROM ${wards.table} w
    JOIN ${layer.table} r
      ON ST_Intersects(r.${layer.rastCol}, w.${wards.geomCol})
    CROSS JOIN LATERAL (
      SELECT ST_Clip(r.${layer.rastCol}, ${layer.band}, w.${wards.geomCol}, true) AS rast
    ) clipped
    WHERE clipped.rast IS NOT NULL
    GROUP BY w.${wards.idCol};
  `;
  const { rows } = await query(sql);
  const map = new Map();
  rows.forEach((row) => map.set(row.ward_id, row.value === null ? 0 : Number(row.value)));
  return map;
}

async function zonalMode(layer, wards) {
  // For each ward, count pixels per raw class value across all intersecting
  // tiles, then keep the value with the highest count.
  const sql = `
    SELECT w.${wards.idCol} AS ward_id, vc.value, SUM(vc.count) AS px_count
    FROM ${wards.table} w
    JOIN ${layer.table} r
      ON ST_Intersects(r.${layer.rastCol}, w.${wards.geomCol})
    CROSS JOIN LATERAL (
      SELECT (ST_ValueCount(
        ST_Clip(r.${layer.rastCol}, ${layer.band}, w.${wards.geomCol}, true), ${layer.band}
      )).*
    ) vc
    GROUP BY w.${wards.idCol}, vc.value
    ORDER BY w.${wards.idCol}, px_count DESC;
  `;
  const { rows } = await query(sql);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.ward_id)) {
      const cls = config.landcoverClassMap[row.value] ?? 'bare';
      map.set(row.ward_id, cls); // first row per ward_id is the highest count, thanks to ORDER BY
    }
  }
  return map;
}

/** Min-max normalizes a Map<wardId, number> to 0..1. Flat inputs map to 0.5. */
function normalize(map) {
  const values = [...map.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const out = new Map();
  map.forEach((v, k) => out.set(k, span === 0 ? 0.5 : (v - min) / span));
  return out;
}

module.exports = { zonalStatsForLayer, normalize };
