#!/usr/bin/env node
/**
 * Generates build/icon.png (1024x1024) from pure math — no image deps, no binary blobs
 * checked into git. electron-builder derives .icns / .ico / linux png from it.
 *
 * The mark is an arcane sigil: concentric rings, a bound diamond, and twelve glyphs
 * around the core — Erebus, the primordial darkness, as a navigator's chart.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'icon.png');
const SIZE = 1024;
const SS = 3; // supersampling factor
const C = SIZE / 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const TAU = Math.PI * 2;

/* ------------------------------------------------------------- primitives */

function roundedRectDist(x, y, w, h, r) {
  const qx = Math.abs(x) - (w - r);
  const qy = Math.abs(y) - (h - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function segmentDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

const ringDist = (d, radius, width) => Math.abs(d - radius) - width / 2;
const polar = (radius, angle) => [C + radius * Math.cos(angle), C + radius * Math.sin(angle)];

/** Cheap value noise for the mottled backdrop. */
function noise(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function smoothNoise(x, y, scale) {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = noise(x0, y0);
  const n10 = noise(x0 + 1, y0);
  const n01 = noise(x0, y0 + 1);
  const n11 = noise(x0 + 1, y0 + 1);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

/* ------------------------------------------------------------ composition */

const RINGS = [
  [406, 5],
  [386, 3],
  [330, 7],
  [300, 4],
  [214, 6],
  [176, 3],
];

const DIAMOND = [0, 1, 2, 3].map((i) => polar(430, (-Math.PI / 2) + (i * TAU) / 4));
const TRIANGLE = [0, 1, 2].map((i) => polar(430, (-Math.PI / 2) + (i * TAU) / 3));

/** Twelve glyph "keys" pointing outward from the core, like hands on a dial. */
function glyphDist(x, y) {
  let d = Infinity;
  for (let i = 0; i < 12; i++) {
    const angle = (-Math.PI / 2) + (i * TAU) / 12;
    const [ix, iy] = polar(64, angle);
    const [ox, oy] = polar(150, angle);
    d = Math.min(d, segmentDist(x, y, ix, iy, ox, oy) - 4);
    // ring at the outer tip
    d = Math.min(d, ringDist(Math.hypot(x - ox, y - oy), 15, 5));
    // crossbar near the inner end
    const [bx, by] = polar(88, angle);
    const [cx1, cy1] = [bx + 16 * Math.cos(angle + Math.PI / 2), by + 16 * Math.sin(angle + Math.PI / 2)];
    const [cx2, cy2] = [bx - 16 * Math.cos(angle + Math.PI / 2), by - 16 * Math.sin(angle + Math.PI / 2)];
    d = Math.min(d, segmentDist(x, y, cx1, cy1, cx2, cy2) - 3.5);
  }
  return d;
}

/** Beads and tick marks riding the rings. */
function ornamentDist(x, y, d, angle) {
  let out = Infinity;
  for (let i = 0; i < 40; i++) {
    const a = (i * TAU) / 40;
    const [bx, by] = polar(358, a);
    out = Math.min(out, Math.hypot(x - bx, y - by) - 7);
  }
  // radial ticks between the two outer rings
  const ticks = 24;
  const nearest = Math.round((angle / TAU) * ticks) * (TAU / ticks);
  if (d > 296 && d < 336) {
    const [tx1, ty1] = polar(300, nearest);
    const [tx2, ty2] = polar(330, nearest);
    out = Math.min(out, segmentDist(x, y, tx1, ty1, tx2, ty2) - 2.5);
  }
  return out;
}

/** The sigil is drawn slightly inset so the rounded square keeps a margin. */
const INSET = 0.84;

function shade(px0, py0) {
  const mx = px0 - C;
  const my = py0 - C;
  // Sigil space: everything below is evaluated on the inset coordinates.
  const x = C + mx / INSET;
  const y = C + my / INSET;
  const dx = x - C;
  const dy = y - C;
  const d = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  /* backdrop: deep midnight, mottled, lifted slightly in the middle */
  const grain = smoothNoise(px0, py0, 46) * 0.6 + smoothNoise(px0, py0, 13) * 0.4;
  let color = mix([9, 14, 30], [21, 30, 58], clamp(grain * 1.15, 0, 1));
  color = mix(color, [40, 52, 96], Math.exp(-1 * ((d / 470) ** 2) * 2.4) * 0.5);
  color = mix(color, [5, 7, 16], clamp((d - 300) / 260, 0, 1) * 0.7);

  /* ink: everything drawn in pale silver */
  let ink = Infinity;
  for (const [radius, width] of RINGS) ink = Math.min(ink, ringDist(d, radius, width));

  for (let i = 0; i < DIAMOND.length; i++) {
    const a = DIAMOND[i];
    const b = DIAMOND[(i + 1) % DIAMOND.length];
    ink = Math.min(ink, segmentDist(x, y, a[0], a[1], b[0], b[1]) - 3);
  }
  for (let i = 0; i < TRIANGLE.length; i++) {
    const a = TRIANGLE[i];
    const b = TRIANGLE[(i + 1) % TRIANGLE.length];
    ink = Math.min(ink, segmentDist(x, y, a[0], a[1], b[0], b[1]) - 3.5);
  }
  for (const [vx, vy] of [...DIAMOND, ...TRIANGLE]) {
    ink = Math.min(ink, ringDist(Math.hypot(x - vx, y - vy), 15, 5));
  }

  ink = Math.min(ink, glyphDist(x, y));
  ink = Math.min(ink, ornamentDist(x, y, d, angle));
  ink = Math.min(ink, Math.hypot(dx, dy) - 22); // core

  /* halo, then the line itself */
  color = mix(color, [122, 146, 214], clamp(Math.exp(-1 * Math.max(ink, 0) / 11), 0, 1) * 0.32);
  color = mix(color, [228, 236, 250], clamp(0.5 - ink * INSET, 0, 1));

  const inside = roundedRectDist(mx, my, C, C, 224);
  return [color[0], color[1], color[2], clamp(0.5 - inside, 0, 1) * 255];
}

/* ------------------------------------------------------------------ raster */

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += px[0];
        g += px[1];
        b += px[2];
        a += px[3];
      }
    }
    const n = SS * SS;
    const o = rowStart + 1 + x * 4;
    raw[o] = clamp(Math.round(r / n), 0, 255);
    raw[o + 1] = clamp(Math.round(g / n), 0, 255);
    raw[o + 2] = clamp(Math.round(b / n), 0, 255);
    raw[o + 3] = clamp(Math.round(a / n), 0, 255);
  }
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`[erebus] wrote ${path.relative(root, out)} (${(png.length / 1024).toFixed(1)} KB)`);
