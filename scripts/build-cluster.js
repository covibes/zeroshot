'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const clusterBuildRoot = path.join(root, '.cluster-build');
const hostedSessionBuildRoot = path.join(root, '.hosted-session-build');
const hostedTargetBuildRoot = path.join(root, '.hosted-target-build');
const clusterOutputRoot = path.join(root, 'lib/cluster');
const hostedSessionOutputRoot = path.join(root, 'lib/hosted-session');
const hostedTargetOutputRoot = path.join(root, 'lib/hosted-target');

function filesBelow(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function declarationContent(source, localExtension) {
  return fs
    .readFileSync(source, 'utf8')
    .replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, (_match, quote, specifier) => {
      const extension = specifier.startsWith('../target/') ? '.js' : localExtension;
      return `${quote}${specifier}${extension}${quote}`;
    });
}

function copyBuild(sourceRoot, outputRoot, mode) {
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
      const base = path.join(outputRoot, relative.slice(0, -5));
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(`${base}.d.ts`, declarationContent(source, '.js'));
      fs.writeFileSync(`${base}.d.cts`, declarationContent(source, '.cjs'));
      fs.writeFileSync(`${base}.d.mts`, declarationContent(source, '.mjs'));
    }
  }
}

fs.rmSync(clusterOutputRoot, { recursive: true, force: true });
fs.rmSync(hostedSessionOutputRoot, { recursive: true, force: true });
fs.rmSync(hostedTargetOutputRoot, { recursive: true, force: true });
copyBuild(path.join(clusterBuildRoot, 'cjs'), clusterOutputRoot, 'cjs');
copyBuild(path.join(clusterBuildRoot, 'esm'), clusterOutputRoot, 'esm');
copyBuild(
  path.join(hostedSessionBuildRoot, 'cjs', 'hosted-session'),
  hostedSessionOutputRoot,
  'cjs'
);
copyBuild(
  path.join(hostedSessionBuildRoot, 'esm', 'hosted-session'),
  hostedSessionOutputRoot,
  'esm'
);
copyBuild(path.join(hostedTargetBuildRoot, 'cjs', 'hosted-target'), hostedTargetOutputRoot, 'cjs');
copyBuild(path.join(hostedTargetBuildRoot, 'esm', 'hosted-target'), hostedTargetOutputRoot, 'esm');
fs.rmSync(clusterBuildRoot, { recursive: true, force: true });
fs.rmSync(hostedSessionBuildRoot, { recursive: true, force: true });
fs.rmSync(hostedTargetBuildRoot, { recursive: true, force: true });
