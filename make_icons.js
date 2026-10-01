// Generates icons/icon{16,32,48,128}.png: green rounded square with a white
// percent glyph. Pure Node (zlib) — no image dependencies.
const fs = require('fs');
const zlib = require('zlib');
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function drawIcon(size) {
  const pix = Buffer.alloc(size * size * 4);
  const green = [5, 122, 85], white = [255, 255, 255];
  const radius = size * 0.22, r = size * 0.5;
  const ring = (sx, sy, cx, cy) => Math.abs(Math.hypot(sx - cx, sy - cy) - size * 0.14) <= size * 0.05;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, glyphCov = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const sx = x + ox - 0.5, sy = y + oy - 0.5;
        const inside = Math.hypot(Math.max(Math.abs(sx - r) - (r - radius), 0), Math.max(Math.abs(sy - r) - (r - radius), 0)) <= radius;
        if (!inside) continue;
        cov++;
        const u = sx / size, v = sy / size;
        const glyph = ring(sx, sy, size * 0.32, size * 0.32) || ring(sx, sy, size * 0.68, size * 0.68)
          || segDist(u, v, 0.72, 0.28, 0.28, 0.72) <= 0.055;
        if (glyph) glyphCov++;
      }
      const i = (y * size + x) * 4;
      if (!cov) continue;
      const g = glyphCov / 4;
      pix[i] = Math.round(green[0] * (1 - g) + white[0] * g);
      pix[i + 1] = Math.round(green[1] * (1 - g) + white[1] * g);
      pix[i + 2] = Math.round(green[2] * (1 - g) + white[2] * g);
      pix[i + 3] = Math.round(255 * cov / 4);
    }
  }
  return png(size, size, pix);
}
fs.mkdirSync('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync('icons/icon' + size + '.png', drawIcon(size));
console.log('icons written');
