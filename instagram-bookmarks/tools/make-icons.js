// ─────────────────────────────────────────────────────────────────────────────
// Icon generator — writes the PWA app icons as PNGs.
//
//   node instagram-bookmarks/tools/make-icons.js
//
// Hand-rolled rasteriser + PNG encoder so the icons stay reproducible from
// source and the project keeps its zero-dependency rule.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public');

// ── PNG encoding ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// `pixels` is RGBA, 4 bytes per pixel, row-major.
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // One filter byte (0 = none) in front of each scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Geometry ──────────────────────────────────────────────────────────────────

// Signed-distance-ish test for a rounded square.
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// The bookmark ribbon: a rounded rect with a notch cut out of the bottom.
function inBookmark(x, y, size, scale) {
  const w = size * 0.40 * scale;
  const h = size * 0.54 * scale;
  const left = (size - w) / 2;
  const top  = (size - h) / 2;
  const right = left + w;
  const bottom = top + h;

  if (!inRoundedRect(x, y, left, top, right, bottom, size * 0.035)) return false;

  const notch = h * 0.30;
  return !inTriangle(x, y, left - 1, bottom + 1, right + 1, bottom + 1, size / 2, bottom - notch);
}

const lerp = (a, b, t) => a + (b - a) * t;

// ── Rendering ─────────────────────────────────────────────────────────────────

// 3×3 supersampling — plenty for shapes this simple, and keeps edges clean.
const SS = 3;

function renderIcon(size, { bleed = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);

  // Instagram-ish warm gradient, corner to corner.
  const from = [240, 128, 60];
  const to   = [214, 49, 127];

  const radius = bleed ? 0 : size * 0.22;
  const glyphScale = bleed ? 0.72 : 1;   // maskable icons must stay inside the safe zone

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const inside = radius
            ? inRoundedRect(px, py, 0, 0, size, size, radius)
            : true;
          if (!inside) continue;

          const t = (px + py) / (size * 2);
          let cr = lerp(from[0], to[0], t);
          let cg = lerp(from[1], to[1], t);
          let cb = lerp(from[2], to[2], t);

          if (inBookmark(px, py, size, glyphScale)) { cr = 255; cg = 255; cb = 255; }

          r += cr; g += cg; b += cb; a += 255;
        }
      }

      const samples = SS * SS;
      const alpha = a / samples;
      const i = (y * size + x) * 4;
      // Store straight (un-premultiplied) colour, which is what PNG expects.
      pixels[i]     = alpha ? Math.round(r / (a / 255)) : 0;
      pixels[i + 1] = alpha ? Math.round(g / (a / 255)) : 0;
      pixels[i + 2] = alpha ? Math.round(b / (a / 255)) : 0;
      pixels[i + 3] = Math.round(alpha);
    }
  }

  return encodePng(size, size, pixels);
}

// ── Write ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png',          renderIcon(192)],
  ['icon-512.png',          renderIcon(512)],
  ['icon-maskable-512.png', renderIcon(512, { bleed: true })]
];

for (const [name, buffer] of outputs) {
  fs.writeFileSync(path.join(OUT_DIR, name), buffer);
  console.log(`wrote ${name} (${(buffer.length / 1024).toFixed(1)} kB)`);
}
