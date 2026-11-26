import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const rootDir = process.cwd();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? clamp((wx * vx + wy * vy) / lenSq, 0, 1) : 0;
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function blendOver(dstR, dstG, dstB, dstA, srcR, srcG, srcB, srcA) {
  const a = clamp(srcA, 0, 1);
  if (a <= 0) return [dstR, dstG, dstB, dstA];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  const r = (srcR * a + dstR * dstA * (1 - a)) / outA;
  const g = (srcG * a + dstG * dstA * (1 - a)) / outA;
  const b = (srcB * a + dstB * dstA * (1 - a)) / outA;
  return [r, g, b, outA];
}

// Evaluate icon SVG design in normalized 512x512 coordinates
function sampleIcon512(x, y, maskable = false) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  const tDiag = clamp((x + y) / 1024, 0, 1);
  const bgR = lerp(13, 9, tDiag);
  const bgG = lerp(18, 11, tDiag);
  const bgB = lerp(28, 16, tDiag);

  if (maskable) {
    r = bgR;
    g = bgG;
    b = bgB;
    a = 1;
  } else {
    const sdfBg = roundedRectSdf(x, y, 256, 256, 256, 256, 96);
    const covBg = clamp(0.7 - sdfBg * 0.85, 0, 1);
    if (covBg > 0) {
      [r, g, b, a] = blendOver(r, g, b, a, bgR, bgG, bgB, covBg);
    }

    // Inner subtle slate frame
    const sdfBorder = Math.abs(roundedRectSdf(x, y, 256, 256, 228, 228, 76)) - 3.0;
    const covBorder = clamp(0.7 - sdfBorder * 0.85, 0, 1);
    if (covBorder > 0) {
      [r, g, b, a] = blendOver(r, g, b, a, 30, 41, 59, covBorder);
    }
  }

  // Scale slightly smaller inside safe zone for maskable icon
  const sx = maskable ? 256 + (x - 256) * 1.18 : x;
  const sy = maskable ? 256 + (y - 256) * 1.18 : y;

  // Base track ring (cx=256, cy=256, r=146, stroke=22)
  const distRing = Math.abs(Math.hypot(sx - 256, sy - 256) - 146) - 11;
  const covRing = clamp(0.7 - distRing * 0.85, 0, 1);
  if (covRing > 0) {
    [r, g, b, a] = blendOver(r, g, b, a, 30, 41, 59, covRing);
  }

  // Cyan telemetry sweep arc: SVG M138 338 A146 146 0 1 1 374 338
  // Bottom endpoints are at dy = +82, dx = +/- 118 -> angle from +Y down is +/- ~55.2 deg
  const dx = sx - 256;
  const dy = sy - 256;
  const angFromBottom = Math.atan2(Math.abs(dx), dy); // 0 at straight down, PI at straight up
  const cutoff = Math.atan2(118, 82); // ~0.963 rad
  const distArcBody = Math.abs(Math.hypot(dx, dy) - 146) - 11;
  const distCapL = Math.hypot(sx - 138, sy - 338) - 11;
  const distCapR = Math.hypot(sx - 374, sy - 338) - 11;
  const distArc = angFromBottom >= cutoff ? distArcBody : Math.min(distCapL, distCapR);
  const covArc = clamp(0.7 - distArc * 0.85, 0, 1);
  if (covArc > 0) {
    const cR = lerp(34, 6, tDiag);
    const cG = lerp(211, 182, tDiag);
    const cB = lerp(238, 212, tDiag);
    [r, g, b, a] = blendOver(r, g, b, a, cR, cG, cB, covArc);
  }

  // White Apex 'A' chevron: M188 334 L256 142 L324 334 (stroke 26, half 13)
  const dLeftLeg = distToSegment(sx, sy, 188, 334, 256, 142) - 13;
  const dRightLeg = distToSegment(sx, sy, 256, 142, 324, 334) - 13;
  const dLegs = Math.min(dLeftLeg, dRightLeg);
  const covLegs = clamp(0.7 - dLegs * 0.85, 0, 1);
  if (covLegs > 0) {
    [r, g, b, a] = blendOver(r, g, b, a, 248, 250, 252, covLegs);
  }

  // Cyan crossbar: M214 276 L298 276 (stroke 22, half 11)
  const dBar = distToSegment(sx, sy, 214, 276, 298, 276) - 11;
  const covBar = clamp(0.7 - dBar * 0.85, 0, 1);
  if (covBar > 0) {
    [r, g, b, a] = blendOver(r, g, b, a, 34, 211, 238, covBar);
  }

  // Amber apex circle: cx=256, cy=142, r=16
  const dApex = Math.hypot(sx - 256, sy - 142) - 16;
  const covApex = clamp(0.7 - dApex * 0.85, 0, 1);
  if (covApex > 0) {
    [r, g, b, a] = blendOver(r, g, b, a, 245, 158, 11, covApex);
  }

  return [r, g, b, a];
}

function renderRgba(size, maskable = false) {
  const samples = size <= 48 ? 4 : size <= 128 ? 3 : 2;
  const invN = 1 / (samples * samples);
  const buf = Buffer.alloc(size * size * 4);
  const scale = 512 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) * scale;
          const py = (y + (sy + 0.5) / samples) * scale;
          const [r, g, b, a] = sampleIcon512(px, py, maskable);
          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
        }
      }
      const outA = accA * invN;
      const idx = (y * size + x) * 4;
      if (outA > 1e-4) {
        buf[idx] = Math.round(clamp(accR / accA, 0, 255));
        buf[idx + 1] = Math.round(clamp(accG / accA, 0, 255));
        buf[idx + 2] = Math.round(clamp(accB / accA, 0, 255));
        buf[idx + 3] = Math.round(clamp(outA * 255, 0, 255));
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }
  return buf;
}

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0))]);
}

export function buildIcoFromPngFrames(frames) {
  // ICONDIR header (6 bytes) + ICONDIRENTRY (16 bytes * N)
  const count = frames.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(count, 4);

  let offset = header.length;
  for (let i = 0; i < count; i++) {
    const { size, png } = frames[i];
    const entryOffset = 6 + i * 16;
    header[entryOffset] = size >= 256 ? 0 : size;
    header[entryOffset + 1] = size >= 256 ? 0 : size;
    header[entryOffset + 2] = 0; // palette colors
    header[entryOffset + 3] = 0; // reserved
    header.writeUInt16LE(1, entryOffset + 4); // planes
    header.writeUInt16LE(32, entryOffset + 6); // bpp
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += png.length;
  }

  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoFrames = icoSizes.map((size) => ({
    size,
    png: encodePng(size, size, renderRgba(size, false)),
  }));
  const icoBuf = buildIcoFromPngFrames(icoFrames);

  fs.mkdirSync(path.join(rootDir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'scripts', 'win'), { recursive: true });

  fs.writeFileSync(path.join(rootDir, 'public', 'apex-engineer.ico'), icoBuf);
  fs.writeFileSync(path.join(rootDir, 'public', 'favicon.ico'), icoBuf);
  fs.writeFileSync(path.join(rootDir, 'scripts', 'win', 'apex-engineer.ico'), icoBuf);

  fs.writeFileSync(path.join(rootDir, 'public', 'apple-touch-icon.png'), encodePng(180, 180, renderRgba(180, false)));
  fs.writeFileSync(path.join(rootDir, 'public', 'pwa-192x192.png'), encodePng(192, 192, renderRgba(192, false)));
  fs.writeFileSync(path.join(rootDir, 'public', 'pwa-512x512.png'), encodePng(512, 512, renderRgba(512, false)));
  fs.writeFileSync(path.join(rootDir, 'public', 'pwa-maskable-512x512.png'), encodePng(512, 512, renderRgba(512, true)));

  console.log(`Generated multi-res ICO (${icoBuf.length} bytes) & crisp PNG icons.`);
}
