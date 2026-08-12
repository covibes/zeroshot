'use strict';

/**
 * Published packages install `dependencies` only. Any bare `require()` in shipped code that
 * resolves to a devDependency works in the repo (where devDependencies are installed) and fails
 * for every consumer — the failure mode that shipped `lib/compose-utils.js` requiring `js-yaml`.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const projectRoot = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

// Read manifest sections directly: a missing section is a manifest defect, not a default.
const runtimeDependencies = new Set([
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.optionalDependencies),
]);
const builtins = new Set(builtinModules);

const fileEntries = manifest.files;
const excludedEntries = fileEntries
  .filter((entry) => entry.startsWith('!'))
  .map((entry) => entry.slice(1).replace(/\/$/, ''));
const includedEntries = fileEntries
  .filter((entry) => !entry.startsWith('!'))
  .map((entry) => entry.replace(/\/$/, ''));

const REQUIRE_PATTERN = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

function isExcluded(relativePath) {
  return excludedEntries.some(
    (entry) => relativePath === entry || relativePath.startsWith(`${entry}/`)
  );
}

function collectPublishedScripts(relativePath, collected) {
  if (isExcluded(relativePath)) return collected;
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return collected;

  if (fs.statSync(absolutePath).isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      if (entry === 'node_modules') continue;
      collectPublishedScripts(path.posix.join(relativePath, entry), collected);
    }
    return collected;
  }

  // Only CommonJS sources are loaded through Node's resolver from the published package.
  if (/\.(js|cjs)$/.test(relativePath)) collected.push(relativePath);
  return collected;
}

function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function isBareSpecifier(specifier) {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return false;
  return !specifier.includes(':');
}

describe('published runtime dependencies', function () {
  it('declares js-yaml as a runtime dependency', function () {
    assert.ok(
      runtimeDependencies.has('js-yaml'),
      'lib/compose-utils.js requires js-yaml from the published package'
    );
    assert.ok(
      !Object.hasOwn(manifest.devDependencies, 'js-yaml'),
      'js-yaml must not be duplicated as a devDependency'
    );
  });

  it('only requires declared runtime dependencies from published files', function () {
    const publishedScripts = includedEntries.reduce(
      (collected, entry) => collectPublishedScripts(entry, collected),
      []
    );
    assert.ok(publishedScripts.length > 0, 'expected published CommonJS files to scan');

    const undeclared = new Map();
    for (const relativePath of publishedScripts) {
      const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
      for (const match of source.matchAll(REQUIRE_PATTERN)) {
        const specifier = match[2];
        if (!isBareSpecifier(specifier)) continue;
        const packageName = packageNameOf(specifier);
        if (builtins.has(packageName) || runtimeDependencies.has(packageName)) continue;
        if (!undeclared.has(packageName)) undeclared.set(packageName, new Set());
        undeclared.get(packageName).add(relativePath);
      }
    }

    assert.deepStrictEqual(
      [...undeclared].map(([name, files]) => `${name} (${[...files].sort().join(', ')})`),
      [],
      'published files must not require packages missing from dependencies/optionalDependencies'
    );
  });
});
