// Minimal zero-dependency QR Code (Byte mode, ECC Level L, Versions 1-10) SVG generator.
// Used solely for one-time local/Tailscale phone pairing URLs (~60-120 ASCII bytes).

const VERSION_INFO = [
  null,
  { size: 21, total: 26, data: 19, ecPerBlock: 7, blocks: [1], align: [] },
  { size: 25, total: 44, data: 34, ecPerBlock: 10, blocks: [1], align: [6, 18] },
  { size: 29, total: 70, data: 55, ecPerBlock: 15, blocks: [1], align: [6, 22] },
  { size: 33, total: 100, data: 80, ecPerBlock: 20, blocks: [1], align: [6, 26] },
  { size: 37, total: 134, data: 108, ecPerBlock: 26, blocks: [1], align: [6, 30] },
  { size: 41, total: 172, data: 136, ecPerBlock: 18, blocks: [2], align: [6, 34] },
  { size: 45, total: 196, data: 156, ecPerBlock: 20, blocks: [2], align: [6, 22, 38] },
  { size: 49, total: 242, data: 194, ecPerBlock: 24, blocks: [2], align: [6, 24, 42] },
  { size: 53, total: 292, data: 232, ecPerBlock: 30, blocks: [2], align: [6, 26, 46] },
  { size: 57, total: 346, data: 274, ecPerBlock: 18, blocks: [2, 2], align: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

function selectVersion(byteLen) {
  for (let v = 1; v < VERSION_INFO.length; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const capacityBits = VERSION_INFO[v].data * 8;
    if (4 + countBits + byteLen * 8 <= capacityBits) return v;
  }
  throw new Error('QR payload exceeds supported version 10 capacity.');
}

function buildCodewords(bytes, version) {
  const spec = VERSION_INFO[version];
  const bits = [];
  const pushBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const capBits = spec.data * 8;
  pushBits(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  for (let i = 0; data.length < spec.data; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

  const numBlocks = spec.blocks.reduce((a, b) => a + b, 0);
  const shortLen = Math.floor(spec.data / numBlocks);
  const longCount = spec.data % numBlocks;
  const shortCount = numBlocks - longCount;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = b < shortCount ? shortLen : shortLen + 1;
    const slice = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
  }
  const interleaved = [];
  const maxDataLen = shortLen + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) interleaved.push(blk[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) interleaved.push(ec[i]);
  }
  return interleaved;
}

function formatBits(mask) {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((rem >>> (i + 12)) & 1) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  const version = selectVersion(bytes.length);
  const spec = VERSION_INFO[version];
  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Uint8Array(n));
  const reserved = Array.from({ length: n }, () => new Uint8Array(n));

  const set = (r, c, dark, isReserved = true) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    grid[r][c] = dark ? 1 : 0;
    if (isReserved) reserved[r][c] = 1;
  };

  const finder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(row + dr, col + dc, inOuter && (onBorder || inCenter));
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  set(n - 8, 8, true);

  for (const r of spec.align) {
    for (const c of spec.align) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Reserve format info areas
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { reserved[8][i] = 1; reserved[i][8] = 1; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = 1;
    reserved[n - 1 - i][8] = 1;
  }

  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = Boolean((vbits >>> i) & 1);
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  const codewords = buildCodewords(bytes, version);
  const mask = 0; // (r + c) % 2 === 0
  let bitIdx = 0;
  let upward = true;
  for (let col = n - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[r][c]) continue;
        const cw = codewords[bitIdx >>> 3] || 0;
        const bit = (cw >>> (7 - (bitIdx & 7))) & 1;
        bitIdx++;
        const inverted = ((r + c) % 2 === 0) ? (bit ^ 1) : bit;
        grid[r][c] = inverted;
      }
    }
    upward = !upward;
  }

  const fbits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = Boolean((fbits >>> i) & 1);
    if (i < 6) grid[i][8] = dark ? 1 : 0;
    else if (i < 8) grid[i + 1][8] = dark ? 1 : 0;
    else grid[n - 15 + i][8] = dark ? 1 : 0;

    if (i < 8) grid[8][n - 1 - i] = dark ? 1 : 0;
    else if (i < 9) grid[8][15 - i] = dark ? 1 : 0;
    else grid[8][14 - i] = dark ? 1 : 0;
  }

  return grid;
}

export function qrSvg(text, { quietZone = 4, moduleSize = 6 } = {}) {
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const total = (n + quietZone * 2) * moduleSize;
  const paths = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;
      paths.push(`M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" role="img" aria-label="QR eşleştirme kodu"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths.join('')}" fill="#0b0d12"/></svg>`;
}
