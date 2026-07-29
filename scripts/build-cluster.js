'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const buildRoot = path.join(root, '.cluster-build');
const outputRoot = path.join(root, 'lib/cluster');

function filesBelow(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function copyBuild(sourceRoot, mode) {
  for (const source of filesBelow(sourceRoot)) {
    const relative = path.relative(sourceRoot, source);
    const extension = path.extname(relative);
    if (extension === '.js') {
      const targetExtension = mode === 'cjs' ? '.cjs' : '.mjs';
      const target = path.join(outputRoot, relative.slice(0, -3) + targetExtension);
      let content = fs.readFileSync(source, 'utf8');
      content = content.replace(
        /(["'])(\.\.?\/[^"']+)\.js\1/g,
        (_match, quote, specifier) => `${quote}${specifier}${targetExtension}${quote}`
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } else if (mode === 'cjs' && extension === '.ts' && relative.endsWith('.d.ts')) {
      const target = path.join(outputRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

fs.rmSync(outputRoot, { recursive: true, force: true });
copyBuild(path.join(buildRoot, 'cjs'), 'cjs');
copyBuild(path.join(buildRoot, 'esm'), 'esm');
fs.rmSync(buildRoot, { recursive: true, force: true });
