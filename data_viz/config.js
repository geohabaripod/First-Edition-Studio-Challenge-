/**
 * Run this in psql to check what you actually have:
 *   \dt silver.*                         -- list tables
 *   \d silver.<table_name>               -- columns for a vector table
 *   SELECT ST_SRID(geom) FROM silver.<table_name> LIMIT 1;   -- projection
 *   SELECT ST_SRID(rast) FROM silver.<table_name> LIMIT 1;   -- for rasters
 */

module.exports = {
  // Coordinate system your frontend map draws in. All geometry returned by
  // the API is reprojected to this SRID with ST_Transform before being sent.
  // 4326 (lon/lat) is simplest — the frontend projection code assumes this.
  targetSRID: 4326,

  vector: {
    studyArea:    { table: 'silver.study_area',    geomCol: 'geom' },
    wards:        { table: 'silver.boundaries', geomCol: 'geom', idCol: 'id',  nameCol: 'ward_name' },
    roads:        { table: 'silver.roads',          geomCol: 'geom', classCol: 'highway_type', simplify: 0.0001 /* e.g. 'arterial' | 'minor', optional */ },
    buildings:    { table: 'silver.buildings',      geomCol: 'geom' },
    rivers:       { table: 'silver.rivers_drainage',         geomCol: 'geom' },
    groundTruth:  { table: 'silver.ground_truth',   geomCol: 'geom' },
  },

  // Raster layers. Each is clipped to each ward polygon and summarized.
  // `stat` controls how a ward's single value is derived from the raster.
  raster: {
    dem:              { table: 'silver.dem',              rastCol: 'rast', band: 1, stat: 'mean' },
    slope:             { table: 'silver.slope',            rastCol: 'rast', band: 1, stat: 'mean' },
    drainageDensity:   { table: 'silver.drainage_distance',  rastCol: 'rast', band: 1, stat: 'mean' },
    rainfall:          { table: 'silver.rainfall',          rastCol: 'rast', band: 1, stat: 'mean' },
    buildingDensity:   { table: 'silver.building_density',  rastCol: 'rast', band: 1, stat: 'mean' },
    population:        { table: 'silver.population',       rastCol: 'rast', band: 1, stat: 'sum' }, // population = sum of a per-pixel count raster
    landcover:         { table: 'silver.landcover',       rastCol: 'rast', band: 1, stat: 'mode' }, // categorical -> majority class
    // Flood hazard: pixel values are integer classes, 0 = no flooding,
    // 1-4 = increasing severity (see silver.flood_hazard.class_scheme).
    // `stat: 'mean'` gives each ward's average severity (e.g. 1.7), which
    // /api/risk then normalizes against the known 0-4 range and buckets
    // into quantile classes — this is what now drives the "Risk Map" output
    // (see routes.js), replacing the old weighted five-raster blend.
    floodHazard:       { table: 'silver.flood_hazard',     rastCol: 'rast', band: 1, stat: 'mean' },
  },

  // Maps raw land cover pixel codes -> the categories your frontend already
  // knows about (trees / shrubland / grassland / cropland / builtup / bare /
  // snow / water / wetlands). The codes below are ESA WorldCover's standard
  // scheme (https://esa-worldcover.org/en) — VERIFY this against your actual
  // raster before relying on it:
  //   SELECT (ST_ValueCount(rast, 1)).* FROM silver.landcover LIMIT 20;
  // If your raster uses different codes, replace the keys below with the
  // ones that query returns. Any raw pixel value found in the raster that
  // is NOT listed here falls through to an auto-assigned fallback color in
  // generate-raster-layers.js (writeLandcoverPNG) rather than being left
  // blank — check that function's console output for "not found in
  // config.landcoverClassMap" warnings after a build run.
  landcoverClassMap: {
    10: 'trees',
    20: 'shrubland',
    30: 'grassland',
    40: 'cropland',
    50: 'builtup',
    60: 'bare',
    70: 'snow',
    80: 'water',
    90: 'wetlands',
  },

  // Flood hazard raster's known fixed value range (see class_scheme on
  // silver.flood_hazard: 0 = no flooding, 1-4 = increasing severity). Used
  // to normalize each ward's mean severity to 0..1 for the risk score in
  // /api/risk. A fixed range (rather than min-max across wards) keeps risk
  // scores comparable across re-runs even if the set of wards present
  // changes.
  floodHazardRange: { min: 0, max: 4 },

  // Risk class quantile cutoffs, applied to wards ranked by risk score
  // (lowest to highest): bottom 25% Low, next 30% Moderate, next 25% High,
  // top 20% Severe. Unchanged from the original weighted-blend model, now
  // applied to flood_hazard-derived scores instead.
  riskQuantiles: { low: 0.25, moderate: 0.55, high: 0.8 },
};