const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build');

// Everything else in build/ is emitted by tsc (including directories.json, via resolveJsonModule)
const assets = [
  'views',
  'public',
];

for (const asset of assets) {
  fs.cpSync(path.join(root, asset), path.join(out, asset), { recursive: true });
}
console.log(`Copied ${assets.length} assets to build/`);
