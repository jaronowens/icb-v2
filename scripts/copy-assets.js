const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build');

const assets = [
  'bin/www',          // no .js extension, so tsc ignores it
  'directories.json', // JSON is not emitted by tsc for require() in JS files
  'views',
  'public',
];

for (const asset of assets) {
  fs.cpSync(path.join(root, asset), path.join(out, asset), { recursive: true });
}
console.log(`Copied ${assets.length} assets to build/`);
