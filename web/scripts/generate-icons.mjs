// Generates every Orbit icon from the single source app/icon.svg.
//   npm run icons   (in web/; output is committed, nothing runs at deploy time)
//
// Source layout (viewBox 0 0 100 100): <rect id="bg"> = rounded blue square,
// <g id="mark"> = white orbit ring (#ring), satellite (#satellite) and core dot (#core).
//
// Outputs
//   app/favicon.ico                    16/32/48 (PNG-encoded ICO entries)
//   app/apple-icon.png                 180x180, opaque full-bleed square (iOS rounds it)
//   public/icons/icon-192.png          rounded square, transparent corners (purpose "any")
//   public/icons/icon-512.png
//   public/icons/icon-maskable-512.png full-bleed, mark inside the 80% safe zone
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WEB, "app", "icon.svg");
const ICONS = join(WEB, "public", "icons");

const source = readFileSync(SRC, "utf8");
const bgColor = /<rect[^>]*id="bg"[^>]*fill="([^"]+)"/.exec(source)?.[1];
const mark = /<g id="mark"[\s\S]*?<\/g>/.exec(source)?.[0];
if (!bgColor || !mark) throw new Error(`${SRC} must contain <rect id="bg" fill=...> and <g id="mark">...</g>`);

/** Tiny sizes: thicker ring, bigger satellite, no core dot (it turns into a grey smudge at 16 px). */
function simplify(m) {
  return m
    .replace(/(<circle id="ring"[^>]*?)r="[^"]+"/, '$1r="26"')
    .replace(/(<circle id="ring"[^>]*?)stroke-width="[^"]+"/, '$1stroke-width="12"')
    .replace(/<circle id="satellite"[^>]*\/>/, '<circle id="satellite" cx="68.4" cy="31.6" r="11"/>')
    .replace(/<circle id="core"[^>]*\/>/, "");
}

/** Compose an icon: background shape + the mark scaled around the centre. */
function svg({ rounded = true, scale = 1, small = false } = {}) {
  const bg = rounded ? `<rect width="100" height="100" rx="22" fill="${bgColor}"/>` : `<rect width="100" height="100" fill="${bgColor}"/>`;
  const t = scale === 1 ? "" : ` transform="translate(${50 - 50 * scale} ${50 - 50 * scale}) scale(${scale})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bg}<g${t}>${small ? simplify(mark) : mark}</g></svg>`;
}

function png(svgText, size) {
  return new Resvg(svgText, { fitTo: { mode: "width", value: size }, shapeRendering: 2, textRendering: 0 }).render().asPng();
}

/** ICO container with PNG-encoded entries (supported by every browser and Windows Vista+). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

mkdirSync(ICONS, { recursive: true });
const out = (path, buf) => {
  writeFileSync(path, buf);
  console.log(`  ${path.slice(WEB.length + 1).replace(/\\/g, "/")}  ${buf.length} B`);
};

out(join(WEB, "app", "favicon.ico"), ico([
  { size: 16, data: png(svg({ small: true }), 16) },
  { size: 32, data: png(svg({ small: true }), 32) },
  { size: 48, data: png(svg(), 48) },
]));
// Opaque: iOS fills transparency with black and applies its own corner mask.
out(join(WEB, "app", "apple-icon.png"), png(svg({ rounded: false, scale: 0.86 }), 180));
out(join(ICONS, "icon-192.png"), png(svg(), 192));
out(join(ICONS, "icon-512.png"), png(svg(), 512));
// Mark extent is radius ~35.5 of 50; scale 0.86 keeps it within ~31 (< 40 = 80% safe-zone circle).
out(join(ICONS, "icon-maskable-512.png"), png(svg({ rounded: false, scale: 0.86 }), 512));

// Files from the previous generator (renamed / now provided by app/ file conventions).
for (const old of ["apple-touch-icon.png", "maskable-512.png", "icon.svg"]) rmSync(join(ICONS, old), { force: true });
