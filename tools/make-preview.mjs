// Generates public/og-image.png — the 1200x630 link-preview poster for Scrapwind, drawn with the
// game's own palette and geometry (the dome gradient, the moon and its craters, dune ridges, and a
// mirror pool holding the moon). Pure pixels + a hand-rolled PNG encoder; no image libraries.
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const W = 1200;
const H = 630;
const HORIZON = 398;
const POOL_TOP = 486;

const ZENITH = [0x2e, 0x6e, 0xd4];
const HORIZON_SKY = [0xff, 0xcf, 0x8e];
const MOON_PALE = [0xe6, 0xdd, 0xd0];
const MOON_MARIA = [0x9c, 0x90, 0x88];
const SAND = [0xd8, 0xa8, 0x6a];
const GROUND_DARK = [0x8a, 0x6a, 0x44];
const RIM_DARK = [0x6e, 0x44, 0x38];
const TEAL = [0x54, 0xe8, 0xd8];

const image = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  const blend = Math.min(a, 1);
  image[i] = Math.round(image[i] * (1 - blend) + r * blend);
  image[i + 1] = Math.round(image[i + 1] * (1 - blend) + g * blend);
  image[i + 2] = Math.round(image[i + 2] * (1 - blend) + b * blend);
};
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const smooth = (edge0, edge1, v) => {
  const t = Math.max(0, Math.min(1, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 1. The sky: the dome's own gradient, top to the horizon.
for (let y = 0; y < HORIZON; y++) {
  const t = Math.pow(y / HORIZON, 0.85);
  const color = ZENITH.map((c, i) => lerp(c, HORIZON_SKY[i], t));
  for (let x = 0; x < W; x++) set(x, y, color);
}

// 2. Cirrus: long feathered streaks, high up.
const streaks = [[90, 150, 380], [60, 130, 640], [200, 110, 300], [260, 210, 520], [150, 70, 760]];
for (const [y, halfWidth, cx] of streaks) {
  for (let x = cx - 420; x < cx + 420; x += 1) {
    const along = smooth(cx - 400, cx - 140, x) * (1 - smooth(cx + 140, cx + 400, x));
    const alpha = along * 0.5 * (0.6 + 0.4 * Math.sin(x * 0.05 + y));
    for (let dy = -halfWidth / 6; dy <= halfWidth / 6; dy++) {
      set(x, y + dy, [0.99 * 255, 0.95 * 255, 0.88 * 255], alpha * (1 - Math.abs(dy) / (halfWidth / 6 + 1)) * 0.5);
    }
  }
}

// 3. The moon: shaded disk, sun-lit craters, a wide faint halo. Same place as in the sky shader.
const moonX = 760, moonY = 190, moonR = 118;
for (let y = moonY - moonR * 2; y <= moonY + moonR * 2; y++) {
  for (let x = moonX - moonR * 2; x <= moonX + moonR * 2; x += 1) {
    const dx = x - moonX, dy = y - moonY;
    const r = Math.hypot(dx, dy);
    const glow = Math.pow(Math.max(0, 1 - r / (moonR * 2.1)), 3) * 0.35;
    set(x, y, MOON_PALE, glow);
    if (r <= moonR) {
      const lit = 0.72 + 0.28 * smooth(moonR * 0.5, -moonR * 0.5, dx + dy);
      let color = MOON_PALE.map(c => c * lit);
      const craters = [[-30, 22, 20], [42, -10, 14], [-8, 46, 26], [18, -38, 9]];
      for (const [ox, oy, cr] of craters) {
        const d = Math.hypot(x - (moonX + ox), y - (moonY + oy));
        const bowl = smooth(cr, cr * 0.45, d) * 0.55;
        const rim = smooth(cr * 1.35, cr * 1.08, d) * smooth(cr * 0.96, cr * 1.1, d) * 0.5;
        color = color.map((c, i) => c * (1 - bowl) + MOON_MARIA[i] * bowl + (MOON_PALE[i] - c) * rim);
      }
      const edge = 1 - smooth(moonR - 2, moonR, r);
      set(x, y, color, edge);
    }
  }
}

// 4. Dune ridges silhouetted against the horizon, darkening toward the viewer.
const ridges = [
  { base: HORIZON - 26, amp: 12, k: 0.008, phase: 1.2, color: [0xb0, 0x78, 0x48] },
  { base: HORIZON - 12, amp: 8, k: 0.013, phase: 2.6, color: [0x9a, 0x64, 0x40] },
  { base: HORIZON - 2, amp: 5, k: 0.02, phase: 0.4, color: RIM_DARK },
];
for (const ridge of ridges) {
  for (let x = 0; x < W; x++) {
    const top = ridge.base + Math.sin(x * ridge.k + ridge.phase) * ridge.amp
      + Math.sin(x * ridge.k * 2.7 + 1) * ridge.amp * 0.3;
    for (let y = Math.max(0, Math.round(top)); y < HORIZON; y++) set(x, y, ridge.color);
  }
}

// 5. The ground below the horizon, darkening with distance from the light.
for (let y = HORIZON; y < POOL_TOP; y++) {
  const t = smooth(HORIZON, POOL_TOP, y);
  const color = SAND.map((c, i) => lerp(c, GROUND_DARK[i], t * 0.8));
  for (let x = 0; x < W; x++) set(x, y, color, 1);
}

// 6. The pool: sky and moon again, mirrored about the water line — squashed half-depth, the way
// still water actually compresses a reflection — and breathed by a ripple.
const moonReflectY = POOL_TOP + (POOL_TOP - moonY) * 0.5;
for (let y = POOL_TOP; y < H; y++) {
  const shore = smooth(POOL_TOP, POOL_TOP + 14, y);
  const depth = smooth(POOL_TOP, H, y);
  for (let x = 0; x < W; x++) {
    const rippleX = Math.round(x + Math.sin(x * 0.05 + y * 0.3) * (1.5 + depth * 2.5));
    const skyY = Math.round(POOL_TOP - (y - POOL_TOP) * 0.5);
    const skyT = Math.pow(Math.max(0, skyY) / HORIZON, 0.85);
    let color = ZENITH.map((c, i) => lerp(c, HORIZON_SKY[i], skyT) * 0.9);
    const smear = Math.max(0, 1 - Math.hypot((rippleX - moonX) / 1.15, (y - moonReflectY) / 78)) * 0.85;
    if (smear > 0) color = color.map((c, i) => c * (1 - smear) + MOON_PALE[i] * smear);
    color = color.map((c, i) => c * (1 - depth * 0.25) + [0x6f, 0xc8, 0xbc][i] * (depth * 0.25) * 0.5);
    set(x, y, color, shore);
  }
}
// The teal rim where water meets land, then the monolith with its lit seam.
for (let x = 0; x < W; x++) {
  set(x, POOL_TOP + 1, TEAL, 0.5 * (0.7 + 0.3 * Math.sin(x * 0.02)));
  set(x, POOL_TOP + 2, TEAL, 0.25);
}
for (let y = POOL_TOP - 64; y < POOL_TOP + 6; y++) {
  for (let x = 830; x < 846; x++) set(x, y, [0x2c, 0x2f, 0x33]);
  for (let x = 837; x < 840; x++) set(x, y, TEAL, 0.8);
}

// ---- PNG encoding: signature, IHDR, one filtered IDAT, IEND. ----
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let index = 0; index < buffer.length; index++) crc = (crc >>> 8) ^ table[(crc ^ buffer[index]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  image.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type: truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og-image.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(0)} kB)`);