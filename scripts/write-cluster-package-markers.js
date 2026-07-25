#!/usr/bin/env node
/**
 * Writes the `{"type": ...}` package.json markers `lib/cluster/{cjs,esm}` need so Node's module
 * loader treats each build's `.js` output with the correct module system, independent of the
 * repo root package.json (which has no "type" field, i.e. defaults to CommonJS).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const markers = [
  { dir: path.join(repoRoot, 'lib', 'cluster', 'cjs'), type: 'commonjs' },
  { dir: path.join(repoRoot, 'lib', 'cluster', 'esm'), type: 'module' },
];

for (const marker of markers) {
  fs.mkdirSync(marker.dir, { recursive: true });
  fs.writeFileSync(
    path.join(marker.dir, 'package.json'),
    JSON.stringify({ type: marker.type }, null, 2) + '\n'
  );
}
