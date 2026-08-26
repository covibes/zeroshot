'use strict';

const fs = require('node:fs');

const SHARED_PREFIXES = ['crates/openengine-cluster-protocol/', 'protocol/'];
const SHARED_PATHS = new Set([
  '.github/ci-path-classifier.js',
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/pr-policy.yml',
  '.dockerignore',
  'eslint.config.mjs',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.json',
  'scripts/generate-cluster-types.js',
  'scripts/opcore-introduced-check.js',
  'tests/unit/ci-path-classifier.test.js',
  'tests/unit/release-hygiene.test.js',
  'tests/unit/release-topology.test.js',
]);

const RUST_PREFIXES = [
  'crates/openengine-cluster-client/',
  'crates/openengine-cluster-server/',
  'crates/openengine-cluster-testkit/',
  'crates/openengine-test-support/',
  'zeroshot-rust/',
  'npm/zeroshot-rust/',
  'distribution/',
  'docker/zeroshot-rust-target/',
  // Keep deletions from the one-time public rename in the Rust lane.
  'docker/zeroshot-v2-target/',
  'docs/zeroshot-rust',
  'tests/unit/rust-',
];
const RUST_PATHS = new Set([
  '.github/workflows/release-rust.yml',
  'Cargo.lock',
  'Cargo.toml',
  'clippy.toml',
  'rust-toolchain.toml',
  'rustfmt.toml',
  'scripts/rust-distribution.js',
]);

const PYTHON_PREFIXES = ['sdks/python/'];
const PYTHON_PATHS = new Set(['.github/workflows/release-python.yml']);

const NODE_PREFIXES = [
  '.husky/',
  'bin/',
  'cli/',
  'cluster-hooks/',
  'cluster-scripts/',
  'cluster-templates/',
  'docker/zeroshot-cluster/',
  'docs/',
  'legacy/',
  'lib/',
  'private/',
  'scripts/',
  'src/',
  'task-lib/',
  'test-support/',
  'tests/',
];
const NODE_PATHS = new Set([
  '.github/workflows/codeql.yml',
  '.github/workflows/release.yml',
  '.jscpd.json',
  '.mocharc.cjs',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc.json',
  'build-image.sh',
  'codecov.yml',
  'commitlint.config.js',
]);

function hasPrefix(pathname, prefixes) {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
}

function normalizePath(pathname) {
  const value = String(pathname);
  return value.startsWith('./') ? value.slice(2) : value;
}

function classifyPath(pathname) {
  const normalized = normalizePath(pathname);

  if (SHARED_PATHS.has(normalized) || hasPrefix(normalized, SHARED_PREFIXES)) {
    return 'shared';
  }
  if (RUST_PATHS.has(normalized) || hasPrefix(normalized, RUST_PREFIXES)) {
    return 'rust';
  }
  if (PYTHON_PATHS.has(normalized) || hasPrefix(normalized, PYTHON_PREFIXES)) {
    return 'python';
  }
  if (NODE_PATHS.has(normalized) || hasPrefix(normalized, NODE_PREFIXES)) {
    return 'node';
  }

  // New and ambiguous paths run both lanes until ownership is made explicit.
  return 'shared';
}

function classifyPaths(paths) {
  const ownership = { node: [], rust: [], python: [], shared: [] };
  const selected = new Set();

  for (const pathname of paths) {
    const normalized = normalizePath(pathname);
    if (normalized.length === 0) continue;
    const kind = classifyPath(normalized);
    ownership[kind].push(normalized);
    selected.add(kind);
  }

  if (selected.size === 0) {
    return { node: true, rust: true, python: true, ownership };
  }

  return {
    node: selected.has('node') || selected.has('shared'),
    rust: selected.has('rust') || selected.has('shared'),
    // The SDK wraps the native executable, so every Rust or shared change rechecks Python.
    python: selected.has('python') || selected.has('rust') || selected.has('shared'),
    ownership,
  };
}

function changedPathsFromStdin() {
  const input = fs.readFileSync(0);
  if (input.length === 0) return [];
  const separator = input.includes(0) ? '\0' : /\r?\n/;
  return input.toString('utf8').split(separator).filter(Boolean);
}

function main() {
  const result = classifyPaths(changedPathsFromStdin());
  const { node, rust, python, shared } = result.ownership;
  process.stdout.write(`node=${result.node}\nrust=${result.rust}\npython=${result.python}\n`);
  process.stderr.write(
    `CI ownership: node=${node.length}, rust=${rust.length}, python=${python.length}, shared=${shared.length}\n`
  );
}

module.exports = { classifyPath, classifyPaths };

if (require.main === module) {
  main();
}
