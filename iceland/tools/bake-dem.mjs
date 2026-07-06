// bake-dem.mjs — Offline DEM baker for the Hellissandur eclipse flight sim.
//
// Source: ArcticDEM v4.1 10 m mosaic (Polar Geospatial Center) — open AWS data,
// NO API key. 10 m is the sweet spot here: ~3× sharper than Copernicus GLO-30,
// while the 2 m tiles (100–500 MB each) are overkill for a flight-sim heightmap.
//
// Writes two committed assets the runtime loads:
//   ../assets/snaefellsnes-height.png   2048² elevation, packed R=high byte / G=low byte
//   ../assets/snaefellsnes-height.json  bbox, scale, min/max, landmark local coords
//
// Run once; outputs are committed; never runs at deploy.   cd tools && npm install && npm run bake
//
// Data: © ArcticDEM, Porter et al. / PGC / NSF / NGA  (attribution required at runtime).

import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Configuration -------------------------------------------------------
const BBOX = { w: -24.20, s: 64.70, e: -23.50, n: 65.00 }; // Snæfellsnes tip (~33 km square)
const OUT = 2048;        // output heightmap size (px/side) — 2× the old 30 m bake
const SEA_LEVEL = 0;     // clamp floor (m); nodata/ocean -> 0
const SEA_CUT = 3;       // ArcticDEM's geoid-corrected ocean sits flat at ~1–1.5 m; snap anything
                         //   below this to 0 so the sea is true black/flat (real land rises fast,
                         //   so the lost <3 m sliver is invisible from the air; Hellissandur is ~11 m).
const GEOID = 64;        // ArcticDEM is ELLIPSOIDAL; subtract ~EGM2008 geoid (~64 m in W Iceland)
                         //   to approximate orthometric height so sea ≈ 0 (clean coastline).
const NODATA = -9999;    // ArcticDEM nodata value

// Landmarks (lng, lat) -> emitted as local meters for the runtime spawn/heading/marker.
const HELLISSANDUR = { lng: -23.88,  lat: 64.917 };
const GLACIER      = { lng: -23.776, lat: 64.808 }; // Snæfellsjökull (~1446 m orthometric)

// ArcticDEM v4.1 10 m mosaic supertiles (EPSG:3413) covering the bbox.
// (15_50 = west half, 15_51 = east half; the SW ocean corner falls in the
//  absent tile 14_50 and is correctly handled as sea.)
const TILES = [
  'https://pgc-opendata-dems.s3.amazonaws.com/arcticdem/mosaics/v4.1/10m/15_50/15_50_10m_v4.1_dem.tif',
  'https://pgc-opendata-dems.s3.amazonaws.com/arcticdem/mosaics/v4.1/10m/15_51/15_51_10m_v4.1_dem.tif',
];

// --- Projections ---------------------------------------------------------
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const E3413 = '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
const toXY = (lng, lat) => proj4(WGS84, E3413, [lng, lat]); // WGS84 -> 3413 metres [x,y]

// --- Local-meter frame (matches the sim: +x = east, +z = south, origin = bbox centre) ---
const DEG = Math.PI / 180, M_PER_DEG_LAT = 111320;
const centerLat = (BBOX.s + BBOX.n) / 2, centerLng = (BBOX.w + BBOX.e) / 2;
const mPerDegLng = M_PER_DEG_LAT * Math.cos(centerLat * DEG);
const spanMetersX = (BBOX.e - BBOX.w) * mPerDegLng;
const spanMetersZ = (BBOX.n - BBOX.s) * M_PER_DEG_LAT;
const toLocal = ({ lng, lat }) => ({
  x: Math.round((lng - centerLng) * mPerDegLng),
  z: Math.round((centerLat - lat) * M_PER_DEG_LAT),
});

// 3413 bounding box of the WGS84 rect (corners + edge midpoints + margin, since
// the rect's edges bow slightly in polar stereographic).
function target3413bbox() {
  const xs = [], ys = [];
  for (const la of [BBOX.s, centerLat, BBOX.n])
    for (const lo of [BBOX.w, centerLng, BBOX.e]) { const [x, y] = toXY(lo, la); xs.push(x); ys.push(y); }
  const M = 2000;
  return { x0: Math.min(...xs) - M, y0: Math.min(...ys) - M, x1: Math.max(...xs) + M, y1: Math.max(...ys) + M };
}

// --- Load each tile's 3413 window ----------------------------------------
async function loadWindow(url, tb) {
  const name = url.split('/').pop();
  try {
    const image = await (await fromUrl(url)).getImage();
    const [ox, oy] = image.getOrigin();     // NW corner (3413 x, y)
    const [rx, ry] = image.getResolution(); // rx > 0, ry < 0
    const W = image.getWidth(), H = image.getHeight();
    const tW = ox, tE = ox + W * rx, tN = oy, tS = oy + H * ry;

    const iW = Math.max(tb.x0, tW), iE = Math.min(tb.x1, tE);
    const iN = Math.min(tb.y1, tN), iS = Math.max(tb.y0, tS);
    if (iW >= iE || iS >= iN) { console.log(`  ${name}: no overlap, skipped`); return null; }

    const x0 = Math.max(0, Math.floor((iW - ox) / rx)), x1 = Math.min(W, Math.ceil((iE - ox) / rx));
    const y0 = Math.max(0, Math.floor((iN - oy) / ry)), y1 = Math.min(H, Math.ceil((iS - oy) / ry));
    const data = (await image.readRasters({ window: [x0, y0, x1, y1] }))[0]; // Float32 (m, ellipsoidal)
    const w = x1 - x0, h = y1 - y0;
    console.log(`  ${name}: ${w}×${h} px`);
    return { data, w, h, geoX: ox + x0 * rx, geoY: oy + y0 * ry, rx, ry };
  } catch (e) {
    console.log(`  ${name}: fetch failed (${e.message}) — treating as sea`);
    return null;
  }
}

// Bilinear elevation sample (orthometric) from whichever window contains (lng,lat).
function makeSampler(windows) {
  return (lng, lat) => {
    const [x, y] = toXY(lng, lat);
    for (const { data, w, h, geoX, geoY, rx, ry } of windows) {
      const fx = (x - geoX) / rx, fy = (y - geoY) / ry;
      if (fx < 0 || fx > w - 1 || fy < 0 || fy > h - 1) continue;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
      const v00 = data[y0 * w + x0], v10 = data[y0 * w + x1], v01 = data[y1 * w + x0], v11 = data[y1 * w + x1];
      if (v00 <= NODATA || v10 <= NODATA || v01 <= NODATA || v11 <= NODATA) return SEA_LEVEL; // coast/ocean
      const tx = fx - x0, ty = fy - y0;
      const a = v00 + (v10 - v00) * tx, b = v01 + (v11 - v01) * tx;
      return (a + (b - a) * ty) - GEOID; // ellipsoidal -> ~orthometric
    }
    return SEA_LEVEL; // outside all tiles -> open ocean
  };
}

// --- Main ----------------------------------------------------------------
console.log(`Baking ArcticDEM 10 m for ${JSON.stringify(BBOX)} → ${OUT}²`);
const tb = target3413bbox();
console.log(`  3413 target: x[${tb.x0.toFixed(0)}..${tb.x1.toFixed(0)}] y[${tb.y0.toFixed(0)}..${tb.y1.toFixed(0)}]`);
const windows = (await Promise.all(TILES.map((u) => loadWindow(u, tb)))).filter(Boolean);
if (!windows.length) { console.error('No DEM tiles loaded — aborting.'); process.exit(1); }
const sample = makeSampler(windows);

// Build the height grid (row 0 = north, col 0 = west).
const heights = new Float32Array(OUT * OUT);
let minE = Infinity, maxE = -Infinity;
for (let py = 0; py < OUT; py++) {
  const lat = BBOX.n - (BBOX.n - BBOX.s) * (py + 0.5) / OUT;
  for (let px = 0; px < OUT; px++) {
    const lng = BBOX.w + (BBOX.e - BBOX.w) * (px + 0.5) / OUT;
    let h = sample(lng, lat);
    if (!isFinite(h) || h < SEA_CUT) h = SEA_LEVEL; // nodata / flat ocean -> 0
    heights[py * OUT + px] = h;
    if (h < minE) minE = h;
    if (h > maxE) maxE = h;
  }
}
console.log(`Elevation range: ${minE.toFixed(1)}..${maxE.toFixed(1)} m`);

// Encode: normalize [0,maxE] to 16 bits, packed R=high / G=low (canvas read-back safe).
const png = new PNG({ width: OUT, height: OUT });
const range = (maxE - SEA_LEVEL) || 1;
for (let i = 0; i < OUT * OUT; i++) {
  const g16 = Math.max(0, Math.min(65535, Math.round(((heights[i] - SEA_LEVEL) / range) * 65535)));
  const o = i * 4;
  png.data[o] = (g16 >> 8) & 255; png.data[o + 1] = g16 & 255; png.data[o + 2] = 0; png.data[o + 3] = 255;
}

// --- Write outputs -------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '..', 'assets');
mkdirSync(assets, { recursive: true });
writeFileSync(resolve(assets, 'snaefellsnes-height.png'), PNG.sync.write(png));

const sidecar = {
  // decode: elev = minElevation + ((R<<8 | G) / 65535) * (maxElevation - minElevation)
  encoding: 'rg16-normalized',
  source: 'ArcticDEM v4.1 10m mosaic (EPSG:3413), geoid-corrected',
  bbox: BBOX,
  size: OUT,
  minElevation: SEA_LEVEL,
  maxElevation: Math.round(maxE),
  spanMetersX: Math.round(spanMetersX),
  spanMetersZ: Math.round(spanMetersZ),
  metersPerPixelX: +(spanMetersX / OUT).toFixed(2),
  metersPerPixelY: +(spanMetersZ / OUT).toFixed(2),
  center: { lng: centerLng, lat: centerLat },
  hellissandur: { ...HELLISSANDUR, ...toLocal(HELLISSANDUR) },
  glacier:      { ...GLACIER,      ...toLocal(GLACIER) },
  attribution: 'Elevation © ArcticDEM · PGC / NSF / NGA',
};
writeFileSync(resolve(assets, 'snaefellsnes-height.json'), JSON.stringify(sidecar, null, 2));

console.log('Wrote assets/snaefellsnes-height.png + .json');
console.log(`  Hellissandur local: ${JSON.stringify(toLocal(HELLISSANDUR))}`);
console.log(`  Glacier local:      ${JSON.stringify(toLocal(GLACIER))}`);
console.log(`  spanX=${Math.round(spanMetersX)} m  spanZ=${Math.round(spanMetersZ)} m  (${(spanMetersX / OUT).toFixed(1)} m/px)`);
