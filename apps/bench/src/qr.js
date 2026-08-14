/* Minimal QR Code encoder — byte mode, versions 1..10, ECC levels L/M/Q/H.
 * Written for offline use in a single-file app: no dependencies, no network.
 * Verified module-for-module against Python `segno` (see verify_qr.py).
 */
const QR = (function () {
  'use strict';

  // --- Galois field GF(256) with primitive polynomial 0x11D -------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
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

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** Generator polynomial for `degree` error-correction codewords. */
  function rsGenerator(degree) {
    let poly = [1];
    for (let d = 0; d < degree; d++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let i = 0; i < poly.length; i++) {
        next[i] ^= gfMul(poly[i], 1);
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /** Reed-Solomon remainder of `data` for `ecLen` check codewords. */
  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // --- Version / ECC tables (versions 1..10) ---------------------------------
  // [ecCodewordsPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
  const ECC_TABLE = {
    L: [null,
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
    M: [null,
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
    Q: [null,
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
      [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
      [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
    H: [null,
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
      [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
      [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]]
  };

  const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const MAX_VERSION = 10;

  const dataCapacity = (v, ecc) => {
    const [, g1, d1, g2, d2] = ECC_TABLE[ecc][v];
    return g1 * d1 + g2 * d2;
  };

  // --- Bit buffer -------------------------------------------------------------
  class BitBuffer {
    constructor() { this.bits = []; }
    put(value, length) {
      for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }
    get length() { return this.bits.length; }
  }

  /** UTF-8 encode; QR byte mode is nominally Latin-1 but every reader groks UTF-8. */
  function toBytes(str) { return Array.from(new TextEncoder().encode(str)); }

  function chooseVersion(byteLen, ecc, minVersion) {
    for (let v = Math.max(1, minVersion || 1); v <= MAX_VERSION; v++) {
      const countBits = v <= 9 ? 8 : 16;
      const needed = Math.ceil((4 + countBits + byteLen * 8) / 8);
      if (needed <= dataCapacity(v, ecc)) return v;
    }
    throw new Error(`Payload of ${byteLen} bytes exceeds version ${MAX_VERSION} at ECC ${ecc}`);
  }

  /** Build the final interleaved codeword stream for the payload.
   * `padCompat` reproduces segno's non-conforming extra zero pad byte; it
   * exists only so tests can prove the rest of the pipeline matches segno
   * bit-for-bit. Never enabled in production. */
  function buildCodewords(text, version, ecc, padCompat) {
    const bytes = toBytes(text);
    const capacity = dataCapacity(version, ecc);
    const buf = new BitBuffer();
    buf.put(0b0100, 4);                          // byte mode
    buf.put(bytes.length, version <= 9 ? 8 : 16); // character count
    for (const b of bytes) buf.put(b, 8);

    const capacityBits = capacity * 8;
    buf.put(0, Math.min(4, capacityBits - buf.length)); // terminator
    if (padCompat && buf.length % 8 === 0 && buf.length + 8 <= capacityBits) {
      buf.put(0, 8);
    }
    while (buf.length % 8 !== 0) buf.bits.push(0);      // byte align

    const data = [];
    for (let i = 0; i < buf.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
      data.push(byte);
    }
    const PAD = [0xec, 0x11];
    for (let i = 0; data.length < capacity; i++) data.push(PAD[i % 2]);

    // Split into blocks, RS-encode each, then interleave.
    const [ecLen, g1, d1, g2, d2] = ECC_TABLE[ecc][version];
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < g1; i++) { blocks.push(data.slice(offset, offset + d1)); offset += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(data.slice(offset, offset + d2)); offset += d2; }
    const ecBlocks = blocks.map(b => rsEncode(b, ecLen));

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++)
      for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++)
      for (const b of ecBlocks) out.push(b[i]);
    return out;
  }

  // --- Matrix construction ----------------------------------------------------
  function newMatrix(size) {
    const m = [], reserved = [];
    for (let r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    return { m, reserved, size };
  }

  function placeFinder(g, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        g.m[rr][cc] = inner ? 1 : 0;
        g.reserved[rr][cc] = true;
      }
    }
  }

  function placeAlignment(g, version) {
    const coords = ALIGNMENT[version];
    for (const r of coords) {
      for (const c of coords) {
        // Skip the three positions occupied by finder patterns.
        if ((r === 6 && c === 6) || (r === 6 && c === g.size - 7) ||
            (r === g.size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            g.m[r + dr][c + dc] = ring === 1 ? 0 : 1;
            g.reserved[r + dr][c + dc] = true;
          }
        }
      }
    }
  }

  function placeTiming(g) {
    for (let i = 8; i < g.size - 8; i++) {
      const bit = i % 2 === 0 ? 1 : 0;
      if (!g.reserved[6][i]) { g.m[6][i] = bit; g.reserved[6][i] = true; }
      if (!g.reserved[i][6]) { g.m[i][6] = bit; g.reserved[i][6] = true; }
    }
  }

  function reserveFormat(g, version) {
    for (let i = 0; i < 9; i++) {
      if (!g.reserved[8][i]) { g.reserved[8][i] = true; g.m[8][i] = 0; }
      if (!g.reserved[i][8]) { g.reserved[i][8] = true; g.m[i][8] = 0; }
    }
    for (let i = 0; i < 8; i++) {
      g.reserved[8][g.size - 1 - i] = true; g.m[8][g.size - 1 - i] = 0;
      g.reserved[g.size - 1 - i][8] = true; g.m[g.size - 1 - i][8] = 0;
    }
    g.m[g.size - 8][8] = 1;             // permanent dark module
    g.reserved[g.size - 8][8] = true;
    if (version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          g.reserved[i][g.size - 11 + j] = true; g.m[i][g.size - 11 + j] = 0;
          g.reserved[g.size - 11 + j][i] = true; g.m[g.size - 11 + j][i] = 0;
        }
      }
    }
  }

  function placeData(g, codewords) {
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    const nextBit = () => {
      if (bitIndex >= totalBits) return 0;
      const bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    };
    let upward = true;
    for (let right = g.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing column is skipped entirely
      for (let i = 0; i < g.size; i++) {
        const row = upward ? g.size - 1 - i : i;
        for (const col of [right, right - 1]) {
          if (g.reserved[row][col]) continue;
          g.m[row][col] = nextBit();
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  function applyMask(g, maskIndex) {
    const fn = MASKS[maskIndex];
    const out = g.m.map(row => row.slice());
    for (let r = 0; r < g.size; r++)
      for (let c = 0; c < g.size; c++)
        if (!g.reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
    return out;
  }

  /** ISO/IEC 18004 penalty rules 1-4, itemised. Lower is better. */
  function penaltyParts(m) {
    const size = m.length;
    let score = 0;

    // Rule 1: runs of 5+ same-colour modules in a row or column.
    let n1 = 0, n2 = 0, n3 = 0, n4 = 0;
    for (let i = 0; i < size; i++) {
      for (const getter of [(j) => m[i][j], (j) => m[j][i]]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (getter(j) === getter(j - 1)) {
            run++;
          } else {
            if (run >= 5) n1 += run - 2;
            run = 1;
          }
        }
        if (run >= 5) n1 += run - 2;
      }
    }

    // Rule 2: 2x2 blocks of the same colour.
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++)
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] &&
            m[r][c] === m[r + 1][c + 1]) n2 += 3;

    // Rule 3: finder-like 1:1:3:1:1 patterns preceded or followed by a light
    // area 4 modules wide. Per ISO/IEC 18004 7.8.3, that light area may extend
    // past the symbol boundary, so a pattern flush against an edge counts:
    // the clipped side is treated as light. Omitting that edge case badly
    // under-counts exactly the finder-lookalikes that confuse scanners.
    const N3 = [1, 0, 1, 1, 1, 0, 1];
    const findPattern = (seq, from) => {
      outer: for (let i = from; i + 7 <= size; i++) {
        for (let k = 0; k < 7; k++) if (seq[i + k] !== N3[k]) continue outer;
        return i;
      }
      return -1;
    };
    const anyDark = (seq, lo, hi) => {
      for (let i = Math.max(lo, 0); i < Math.min(hi, size); i++) if (seq[i]) return true;
      return false;
    };
    const scoreN3 = (seq) => {
      let total = 0, idx = findPattern(seq, 0);
      while (idx !== -1) {
        let offset = idx + 7;
        if (idx === 0 || idx === size - 7 ||
            !anyDark(seq, idx - 4, idx) || !anyDark(seq, offset, offset + 4)) {
          total += 40;
        } else {
          offset = idx + 4; // overlapping match may still start mid-pattern
        }
        idx = findPattern(seq, offset);
      }
      return total;
    };
    for (let i = 0; i < size; i++) {
      n3 += scoreN3(m[i]);
      n3 += scoreN3(m.map(r => r[i]));
    }

    // Rule 4: deviation of dark-module proportion from 50%.
    let dark = 0;
    for (const row of m) for (const v of row) dark += v;
    const pct = (dark * 100) / (size * size);
    n4 = Math.floor(Math.abs(pct - 50) / 5) * 10;
    return { n1, n2, n3, n4, total: n1 + n2 + n3 + n4 };
  }

  const penalty = (m) => penaltyParts(m).total;

  function formatBits(ecc, mask) {
    let data = (ECC_BITS[ecc] << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    let rem = version << 12;
    for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    return (version << 12) | rem;
  }

  function writeFormat(m, size, ecc, mask) {
    const bits = formatBits(ecc, mask);
    const bit = (i) => (bits >>> i) & 1;
    // Copy 1: up the left of the top-right finder, then across the top-left.
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
    // Copy 2: along row 8 from the right edge, then down column 8 at the bottom.
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = 1; // permanent dark module
  }

  function writeVersion(m, size, version) {
    if (version < 7) return;
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[r][size - 11 + c] = b;
      m[size - 11 + c][r] = b;
    }
  }

  /**
   * Encode `text` into a QR matrix.
   * @returns {{size:number, modules:number[][], version:number, mask:number}}
   */
  function encode(text, options) {
    const opts = options || {};
    const ecc = opts.ecc || 'M';
    if (!ECC_TABLE[ecc]) throw new Error(`Unknown ECC level: ${ecc}`);
    const version = opts.version || chooseVersion(toBytes(text).length, ecc, opts.minVersion);
    const size = version * 4 + 17;

    const g = newMatrix(size);
    placeFinder(g, 0, 0);
    placeFinder(g, 0, size - 7);
    placeFinder(g, size - 7, 0);
    placeAlignment(g, version);
    placeTiming(g);
    reserveFormat(g, version);
    placeData(g, buildCodewords(text, version, ecc, opts._padCompat));

    // ISO/IEC 18004 7.8: the penalty is evaluated on the masked symbol WITHOUT
    // format and version information. Scoring with them in place biases the
    // choice and picks a different mask than a conforming encoder would.
    let best = null;
    const candidates = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
    for (const mask of candidates) {
      const masked = applyMask(g, mask);
      const score = penalty(masked);
      if (!best || score < best.score) best = { score, mask, modules: masked };
    }
    writeFormat(best.modules, size, ecc, best.mask);
    writeVersion(best.modules, size, version);
    return { size, modules: best.modules, version, mask: best.mask, ecc,
             reserved: g.reserved, preMask: g.m };
  }

  /** Render an encoded matrix as a standalone SVG string. */
  function toSvg(text, options) {
    const opts = options || {};
    const { size, modules } = encode(text, opts);
    const quiet = opts.quietZone === undefined ? 4 : opts.quietZone;
    const total = size + quiet * 2;
    const dark = opts.dark || '#000000';
    const light = opts.light || '#ffffff';
    let path = '';
    for (let r = 0; r < size; r++) {
      let c = 0;
      while (c < size) {
        if (modules[r][c]) {
          let run = 1;
          while (c + run < size && modules[r][c + run]) run++;
          path += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
          c += run;
        } else c++;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${path}" fill="${dark}"/></svg>`;
  }

  return { encode, toSvg, chooseVersion, _rsEncode: rsEncode };
})();

