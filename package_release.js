// Packages the extension's runtime files into dist/tsetmc-ytm-<version>.zip.
// Only files the browser loads (manifest + its referenced assets) are
// included — dev tooling, tests and README stay out, matching what the
// Chrome Web Store expects. Pure Node (STORE entries, no dependencies) so
// the same script runs on Windows, macOS and CI; the written archive is
// parsed back and validated before the script exits.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const outName = `tsetmc-ytm-${manifest.version}.zip`;

const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'styles.css',
  'bonds.json',
  ...fs.readdirSync(path.join(ROOT, 'icons')).filter(f => f.endsWith('.png')).map(f => `icons/${f}`),
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// ZIP stores modification time as (hours<<11 | minutes<<5 | seconds/2) and
// the date as ((year-1980)<<9 | month<<5 | day).
function dosDateTime(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF,
  };
}

const locals = [];
const centrals = [];
const expected = new Map(); // name -> { crc, size } for the read-back check
let offset = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const data = fs.readFileSync(abs);
  const name = Buffer.from(rel, 'utf8');
  const { time, date } = dosDateTime(fs.statSync(abs).mtime);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034B50, 0); // local file header signature
  local.writeUInt16LE(20, 4);         // version needed
  local.writeUInt16LE(0x0800, 6);     // general purpose flag: UTF-8 names
  local.writeUInt16LE(0, 8);          // method: store (no compression)
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);         // extra length
  locals.push(local, name, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014B50, 0); // central directory signature
  central.writeUInt16LE(20, 4);         // version made by
  central.writeUInt16LE(20, 6);         // version needed
  central.writeUInt16LE(0x0800, 8);     // UTF-8 names
  central.writeUInt16LE(0, 10);         // method: store
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);         // extra
  central.writeUInt16LE(0, 32);         // comment
  central.writeUInt16LE(0, 34);         // disk
  central.writeUInt16LE(0, 36);         // internal attributes
  central.writeUInt32LE(0, 38);         // external attributes
  central.writeUInt32LE(offset, 42);    // local header offset
  centrals.push(central, name);

  expected.set(rel, { crc, size: data.length });
  offset += local.length + name.length + data.length;
}

const centralSize = centrals.reduce((total, chunk) => total + chunk.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054B50, 0);   // end-of-central-directory signature
eocd.writeUInt16LE(0, 4);            // this disk
eocd.writeUInt16LE(0, 6);            // disk with central directory
eocd.writeUInt16LE(FILES.length, 8); // entries on this disk
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);      // central directory offset
eocd.writeUInt16LE(0, 20);           // comment length

const archive = Buffer.concat([...locals, ...centrals, eocd]);
const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, outName);
fs.writeFileSync(outPath, archive);

// Read the archive back: EOCD in place, entry count right, every central
// directory record's name/CRC/size matching what went in.
let failed = false;
const fail = message => { failed = true; console.error('FAIL', message); };
const readBack = fs.readFileSync(outPath);
const eocdOffset = readBack.length - 22;
if (readBack.readUInt32LE(eocdOffset) !== 0x06054B50) fail('EOCD signature missing at archive end');
else if (readBack.readUInt16LE(eocdOffset + 10) !== FILES.length) fail('entry count mismatch in EOCD');
if (readBack.readUInt32LE(eocdOffset + 16) !== offset) fail('central directory offset mismatch');
let cursor = offset;
for (const rel of FILES) {
  if (readBack.readUInt32LE(cursor) !== 0x02014B50) { fail(`central header missing for ${rel}`); break; }
  const nameLen = readBack.readUInt16LE(cursor + 28);
  const crc = readBack.readUInt32LE(cursor + 16);
  const size = readBack.readUInt32LE(cursor + 24);
  const name = readBack.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
  const want = expected.get(rel);
  if (name !== rel) fail(`name mismatch: ${name} != ${rel}`);
  if (crc !== want.crc || size !== want.size) fail(`crc/size mismatch for ${rel}`);
  cursor += 46 + nameLen + readBack.readUInt16LE(cursor + 30) + readBack.readUInt16LE(cursor + 32);
}
if (failed) process.exit(1);

console.log(`packed ${FILES.length} files -> dist/${outName} (${(archive.length / 1024).toFixed(1)} KB)`);
console.log(FILES.join('\n'));
