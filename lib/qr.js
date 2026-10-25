'use strict';
/**
 * Minimal QR Code generator (byte mode, error-correction level M, versions 1-10).
 * Zero dependencies. Output: boolean matrix, SVG string or PNG buffer.
 * Good for up to 213 bytes of text (plenty for a receipt URL).
 */
const zlib = require('zlib');

// Level M tables, index = version (1..10)
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
// [blocks in group1, data codewords per group1 block, blocks in group2, data cw per group2 block]
const BLOCKS = [
  null,
  [1, 16, 0, 0], [1, 28, 0, 0], [1, 44, 0, 0], [2, 32, 0, 0], [2, 43, 0, 0],
  [4, 27, 0, 0], [4, 31, 0, 0], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44],
];
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// ---------- Reed-Solomon over GF(256) ----------
const EXP = new Array(512);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly; // highest degree first, leading coefficient 1
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ---------- bit buffer ----------
function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function dataCapacity(version) {
  const b = BLOCKS[version];
  return b[0] * b[1] + b[2] * b[3];
}

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const ccBits = v < 10 ? 8 : 16;
    const needed = 4 + ccBits + byteLen * 8;
    if (needed <= dataCapacity(v) * 8) return v;
  }
  throw new Error('Text too long for QR (max ~213 bytes)');
}

function buildCodewords(bytes, version) {
  const bits = [];
  pushBits(bits, 0b0100, 4); // byte mode
  pushBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);
  const capBits = dataCapacity(version) * 8;
  pushBits(bits, 0, Math.min(4, capBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const total = dataCapacity(version);
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  // split into blocks
  const [g1n, g1len, g2n, g2len] = BLOCKS[version];
  const ecLen = EC_PER_BLOCK[version];
  const dataBlocks = [];
  let pos = 0;
  for (let i = 0; i < g1n; i++) { dataBlocks.push(data.slice(pos, pos + g1len)); pos += g1len; }
  for (let i = 0; i < g2n; i++) { dataBlocks.push(data.slice(pos, pos + g2len)); pos += g2len; }
  const ecBlocks = dataBlocks.map((blk) => rsRemainder(blk, ecLen));

  // interleave
  const out = [];
  const maxLen = Math.max(g1len, g2len);
  for (let i = 0; i < maxLen; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) out.push(blk[i]);
  return out;
}

// ---------- matrix construction ----------
function makeMatrix(size) {
  return {
    size,
    mod: Array.from({ length: size }, () => new Array(size).fill(false)),
    fn: Array.from({ length: size }, () => new Array(size).fill(false)), // function-pattern flags
  };
}

function setFn(m, x, y, dark) {
  m.mod[y][x] = dark;
  m.fn[y][x] = true;
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(m, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function bchFormat(data) {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormat(m, mask) {
  const bits = bchFormat((0b00 << 3) | mask); // EC level M = 00
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const n = m.size;
  for (let i = 0; i <= 5; i++) setFn(m, 8, i, bit(i));
  setFn(m, 8, 7, bit(6));
  setFn(m, 8, 8, bit(7));
  setFn(m, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(m, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFn(m, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFn(m, 8, n - 15 + i, bit(i));
  setFn(m, 8, n - 8, true); // always-dark module
}

function drawFunctionPatterns(m, version) {
  const n = m.size;
  // timing
  for (let i = 0; i < n; i++) {
    setFn(m, 6, i, i % 2 === 0);
    setFn(m, i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, n - 4, 3);
  drawFinder(m, 3, n - 4);
  const pos = ALIGN[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      drawAlignment(m, pos[i], pos[j]);
    }
  }
  drawFormat(m, 0); // reserve area (rewritten later with the real mask)
  if (version >= 7) {
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(m, a, b, dark);
      setFn(m, b, a, dark);
    }
  }
}

function placeData(m, codewords) {
  const n = m.size;
  const bits = [];
  for (const cw of codewords) pushBits(bits, cw, 8);
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!m.fn[y][x] && i < bits.length) {
          m.mod[y][x] = bits[i] === 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.fn[y][x] && MASKS[mask](x, y)) m.mod[y][x] = !m.mod[y][x];
    }
  }
}

function penalty(m) {
  const n = m.size;
  const g = m.mod;
  let score = 0;
  // rule 1: runs of 5+ in rows / columns
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass === 0 ? g[a][b] : g[b][a];
        const prev = pass === 0 ? g[a][b - 1] : g[b - 1][a];
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  // rule 2: 2x2 blocks
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = g[y][x];
      if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) score += 3;
    }
  }
  // rule 3: finder-like patterns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b <= n - 11; b++) {
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = (pass === 0 ? g[a][b + k] : g[b + k][a]) ? 1 : 0;
          if (v !== pat1[k]) m1 = false;
          if (v !== pat2[k]) m2 = false;
          if (!m1 && !m2) break;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
  }
  // rule 4: dark ratio
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g[y][x]) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Returns { size, modules: boolean[][] } */
function encode(text, opts = {}) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const size = version * 4 + 17;

  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    if (opts.mask !== undefined && mask !== opts.mask) continue;
    const m = makeMatrix(size);
    drawFunctionPatterns(m, version);
    placeData(m, codewords);
    applyMask(m, mask);
    drawFormat(m, mask);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      best = m;
      bestMask = mask;
    }
  }
  return { size, version, mask: bestMask, modules: best.mod };
}

/** SVG string. */
function toSVG(text, { margin = 4, dark = '#0F1B3D', light = '#FFFFFF' } = {}) {
  const { size, modules } = encode(text);
  const full = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (modules[y][x]) {
        let w = 1;
        while (x + w < size && modules[y][x + w]) w++;
        path += `M${x + margin},${y + margin}h${w}v1h-${w}z`;
        x += w;
      } else x++;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`
  );
}

// ---------- PNG writer ----------
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG buffer (grayscale). scale = pixels per module. */
function toPNG(text, { scale = 8, margin = 4 } = {}) {
  const { size, modules } = encode(text);
  const full = (size + margin * 2) * scale;
  const rowLen = full + 1;
  const raw = Buffer.alloc(rowLen * full, 255);
  for (let py = 0; py < full; py++) {
    raw[py * rowLen] = 0; // filter: none
    const my = Math.floor(py / scale) - margin;
    for (let px = 0; px < full; px++) {
      const mx = Math.floor(px / scale) - margin;
      const isDark = my >= 0 && mx >= 0 && my < size && mx < size && modules[my][mx];
      raw[py * rowLen + 1 + px] = isDark ? 15 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(full, 0);
  ihdr.writeUInt32BE(full, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encode, toSVG, toPNG };
