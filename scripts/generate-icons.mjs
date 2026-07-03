// Generates the OpenSidekick toolbar/store icons as PNGs with no external
// dependencies (hand-rolled PNG encoder + zlib). The mark is a white ring on a
// rounded indigo square — a simple, brand-neutral placeholder. Replace with a
// designed icon before a public store listing if you like.
//
// Run: node scripts/generate-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const BG = [79, 70, 229]; // indigo
const RING = [255, 255, 255];
const SS = 4; // supersampling factor for anti-aliasing

function renderIcon(size) {
  const S = size * SS;
  const cx = S / 2;
  const cy = S / 2;
  const corner = S * 0.24;
  const halfW = S / 2;
  const ringOuter = S * 0.34;
  const ringInner = S * 0.2;
  const ringWidth = S * 0.075;

  // Supersampled boolean layers, then box-downsample to size for AA.
  const big = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const insideSquare = roundedRectInside(x + 0.5, y + 0.5, cx, cy, halfW, halfW, corner);
      if (!insideSquare) {
        big[i + 3] = 0;
        continue;
      }
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // Ring band + a small dot in the middle for an "eye/agent" feel.
      const inRing = d > ringOuter - ringWidth && d < ringOuter;
      const inDot = d < ringInner - ringWidth * 1.5;
      const c = inRing || inDot ? RING : BG;
      big[i] = c[0];
      big[i + 1] = c[1];
      big[i + 2] = c[2];
      big[i + 3] = 255;
    }
  }
  return { width: size, height: size, data: downsample(big, S, size) };
}

function roundedRectInside(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  if (dx <= 0 || dy <= 0) {
    return Math.abs(px - cx) <= halfW && Math.abs(py - cy) <= halfH;
  }
  return Math.hypot(dx, dy) <= radius;
}

function downsample(big, S, size) {
  const out = new Uint8Array(size * size * 4);
  const step = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const bx = Math.floor(x * step + sx);
          const by = Math.floor(y * step + sy);
          const i = (by * S + bx) * 4;
          const al = big[i + 3];
          r += big[i] * al;
          g += big[i + 1] * al;
          b += big[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const alpha = a / n;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ---- Minimal PNG encoder (RGBA, no interlace) ----
function encodePNG({ width, height, data }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter byte 0 per scanline.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    data.copy
      ? data.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Driver (runs last, after all declarations are initialized) ----
mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(renderIcon(size));
  writeFileSync(join(OUT_DIR, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png`);
}
