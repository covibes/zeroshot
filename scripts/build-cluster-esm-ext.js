#!/usr/bin/env node
'use strict';

// Post-processes the tsc-emitted lib/cluster/esm/ tree: renames every `.js`/`.js.map` to
// `.mjs`/`.mjs.map` and rewrites internal relative specifiers (import/export/sourceMappingURL) to
// match, so Node and bundlers recognize this output as ESM purely from its file extension --
// without needing a `lib/cluster/esm/package.json` sidecar to declare `"type": "module"`.
//
// Usage: node scripts/build-cluster-esm-ext.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ESM_DIR = path.join(REPO_ROOT, 'lib', 'cluster', 'esm');

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(entryPath);
    }
  }
  return out;
}

function rewriteSpecifiers(source) {
  return source
    .replace(/(from\s+['"])(\.\.?\/[^'"]+)\.js(['"])/g, '$1$2.mjs$3')
    .replace(/(import\(\s*['"])(\.\.?\/[^'"]+)\.js(['"]\s*\))/g, '$1$2.mjs$3')
    .replace(/(\/\/# sourceMappingURL=)([^\s]+)\.js\.map/, '$1$2.mjs.map');
}

function rewriteSourceMap(mapPath) {
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (typeof map.file === 'string' && map.file.endsWith('.js')) {
    map.file = `${map.file.slice(0, -'.js'.length)}.mjs`;
  }
  fs.writeFileSync(mapPath, JSON.stringify(map));
}

function main() {
  if (!fs.existsSync(ESM_DIR)) {
    throw new Error(
      `build-cluster-esm-ext: ${path.relative(REPO_ROOT, ESM_DIR)} does not exist -- run the ESM tsc build first`
    );
  }

  const jsFiles = listJsFiles(ESM_DIR);
  for (const jsPath of jsFiles) {
    const mapPath = `${jsPath}.map`;
    const mjsPath = `${jsPath.slice(0, -'.js'.length)}.mjs`;
    const mjsMapPath = `${mjsPath}.map`;

    const rewritten = rewriteSpecifiers(fs.readFileSync(jsPath, 'utf8'));
    fs.writeFileSync(jsPath, rewritten);
    fs.renameSync(jsPath, mjsPath);

    if (fs.existsSync(mapPath)) {
      fs.renameSync(mapPath, mjsMapPath);
      rewriteSourceMap(mjsMapPath);
    }
  }

  // stderr, not stdout: this script runs as part of the `prepare` lifecycle hook, which fires
  // before `npm pack`/`npm publish` -- stdout noise there would corrupt `npm pack --json`'s output.
  process.stderr.write(
    `Renamed ${jsFiles.length} file(s) to .mjs under ${path.relative(REPO_ROOT, ESM_DIR)}\n`
  );
}

main();
