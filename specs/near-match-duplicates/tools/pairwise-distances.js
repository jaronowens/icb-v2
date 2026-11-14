// Hashes every image in a directory at 8 and 16 bits and prints the closest pairs by Hamming distance.
// Usage (from the repo root): node specs/near-match-duplicates/tools/pairwise-distances.js <imageDir> <hashes-out.json>
// Uses image-hash, which the app no longer depends on: run `npm install --no-save image-hash` first.
// The app now hashes with sharp + blockhash; specs/background-perceptual-hash/tools/compare-decoders.ts --pairs gives the same pair listing for it.
const { createRequire } = require('module');
const fs = require('fs'), path = require('path');
const req = createRequire(path.join(__dirname, '..', '..', '..', 'package.json'));
const { imageHash } = req('image-hash');
const dir = process.argv[2];
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; };
(async () => {
  const files = fs.readdirSync(dir).sort((a, b) => parseInt(a) - parseInt(b));
  const h = {};
  for (const f of files) {
    h[f] = {};
    for (const bits of [8, 16]) {
      try { h[f][bits] = await imageHash(path.join(dir, f), bits, true); } catch (e) { h[f][bits] = null; console.log('FAIL', f, bits, e.message); }
    }
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(h, null, 1));
  const pairs = [];
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    const a = h[files[i]], b = h[files[j]];
    if (!a[8] || !b[8]) continue;
    pairs.push({ a: files[i], b: files[j], d8: ham(a[8], b[8]), d16: ham(a[16], b[16]) });
  }
  pairs.sort((x, y) => x.d16 - y.d16);
  console.log('closest pairs (d8 of 64 bits, d16 of 256 bits):');
  pairs.filter(p => p.d8 <= 12 || p.d16 <= 60).forEach(p => console.log(`${p.a.padEnd(7)} ${p.b.padEnd(7)} d8=${String(p.d8).padStart(2)} d16=${String(p.d16).padStart(3)}`));
  const all8 = pairs.map(p => p.d8).sort((a, b) => a - b);
  console.log(`\n${pairs.length} pairs total; d8 distribution of the rest: min ${all8[0]}, 5th pct ${all8[Math.floor(all8.length * 0.05)]}, median ${all8[Math.floor(all8.length / 2)]}`);
})();
