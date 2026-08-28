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

  // Risk model weights — copied from the original synthetic model so results
  // stay comparable. rainfall/drainage/elevation/slope/buildingDensity are
  // each min-max normalized across wards (0-1) before this formula is applied.
  riskWeights: {
    rainfall: 0.28,
    drainageDensity: 0.20,
    inverseElevation: 0.24,
    inverseSlope: 0.13,
    buildingDensity: 0.15,
  },
};