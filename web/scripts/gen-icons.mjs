// Generates Orbit PWA icons (PNG, no deps). Run: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const PRIMARY = [0x0b, 0x57, 0xd0];
const WHITE = [255, 255, 255];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Is unit-space point (x,y) inside the rounded square (corner radius r, 0 = full bleed)?
function inRoundedSquare(x, y, r) {
  if (r <= 0) return true;
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
}

/** radius: corner radius in unit space (0 = full bleed); scale: glyph scale (<1 for safe zones). */
function render(size, { radius, scale }) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling per axis
  const ang = -Math.PI / 4;
  const planetX = 0.27 * Math.cos(ang);
  const planetY = 0.27 * Math.sin(ang);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i + (si + 0.5) / SS) / size;
          const y = (j + (sj + 0.5) / SS) / size;
          if (!inRoundedSquare(x, y, radius)) continue;
          const dx = (x - 0.5) / scale;
          const dy = (y - 0.5) / scale;
          const dist = Math.hypot(dx, dy);
          const ring = Math.abs(dist - 0.27) <= 0.045;
          const planet = Math.hypot(dx - planetX, dy - planetY) <= 0.085;
          const core = dist <= 0.07;
          const c = ring || planet || core ? WHITE : PRIMARY;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      if (!hits) continue;
      const o = (j * size + i) * 4;
      buf[o] = Math.round(r / hits);
      buf[o + 1] = Math.round(g / hits);
      buf[o + 2] = Math.round(b / hits);
      buf[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return encodePng(size, buf);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ["icon-192.png", 192, { radius: 0.22, scale: 1 }],
  ["icon-512.png", 512, { radius: 0.22, scale: 1 }],
  // maskable: full-bleed background, glyph inside the central safe zone
  ["maskable-512.png", 512, { radius: 0, scale: 0.8 }],
  // apple: iOS rounds the corners itself, so full-bleed
  ["apple-touch-icon.png", 180, { radius: 0, scale: 0.9 }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), render(size, opts));
  console.log("wrote", name);
}
