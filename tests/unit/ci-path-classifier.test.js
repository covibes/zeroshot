const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { classifyPath, classifyPaths } = require('../../.github/ci-path-classifier');

const projectRoot = path.resolve(__dirname, '..', '..');
const classifierPath = path.join(projectRoot, '.github', 'ci-path-classifier.js');

it('classifies product-owned paths without starting the other lane', function () {
  assert.equal(classifyPath('src/orchestrator.js'), 'node');
  assert.equal(classifyPath('docker/zeroshot-cluster/Dockerfile'), 'node');
  assert.deepEqual(classifyPaths(['src/orchestrator.js', 'tests/cli-run-mode.test.js']), {
    node: true,
    rust: false,
    ownership: {
      node: ['src/orchestrator.js', 'tests/cli-run-mode.test.js'],
      rust: [],
      shared: [],
    },
  });

  assert.equal(classifyPath('zeroshot-rust/src/main.rs'), 'rust');
  assert.equal(classifyPath('docker/zeroshot-rust-target/Dockerfile'), 'rust');
  assert.equal(classifyPath('docs/zeroshot-rust-distribution.md'), 'rust');
  assert.equal(classifyPath('.github/workflows/release-rust.yml'), 'rust');
  assert.equal(classifyPath('crates/openengine-cluster-server/src/native_v2.rs'), 'rust');
  assert.equal(classifyPath('crates/openengine-cluster-testkit/src/conformance.rs'), 'rust');
  assert.deepEqual(classifyPaths(['zeroshot-rust/src/main.rs', 'npm/zeroshot-rust/install.js']), {
    node: false,
    rust: true,
    ownership: {
      node: [],
      rust: ['zeroshot-rust/src/main.rs', 'npm/zeroshot-rust/install.js'],
      shared: [],
    },
  });
});

it('runs both lanes for shared, mixed, unknown, and empty changes', function () {
  for (const pathname of [
    'crates/openengine-cluster-protocol/src/graph.rs',
    'protocol/openengine-cluster/v1/graph.schema.json',
    '.github/workflows/ci.yml',
    '.github/ci-path-classifier.js',
    '.dockerignore',
    'eslint.config.mjs',
    'npm-shrinkwrap.json',
    'package.json',
    'package-lock.json',
    'new-top-level-product/file.txt',
  ]) {
    assert.equal(classifyPath(pathname), 'shared');
    assert.deepEqual(
      { node: classifyPaths([pathname]).node, rust: classifyPaths([pathname]).rust },
      { node: true, rust: true }
    );
  }

  assert.equal(classifyPath('.github/workflows/release.yml'), 'node');
  assert.equal(classifyPath('.github/workflows/codeql.yml'), 'node');

  const mixed = classifyPaths(['src/orchestrator.js', 'zeroshot-rust/src/main.rs']);
  assert.deepEqual({ node: mixed.node, rust: mixed.rust }, { node: true, rust: true });
  assert.deepEqual(
    { node: classifyPaths([]).node, rust: classifyPaths([]).rust },
    { node: true, rust: true }
  );
});

it('emits GitHub outputs from null-delimited git paths', function () {
  const result = spawnSync(process.execPath, [classifierPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: 'zeroshot-rust/src/main.rs\0npm/zeroshot-rust/install.js\0',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'node=false\nrust=true\n');
});

it('keeps one always-starting classifier and one stable aggregate result', function () {
  const workflow = fs.readFileSync(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
  const codeql = fs.readFileSync(path.join(projectRoot, '.github/workflows/codeql.yml'), 'utf8');
  const triggers = workflow.slice(0, workflow.indexOf('\njobs:'));

  assert.match(workflow, /\n {2}classify:\n/);
  assert.match(workflow, /node \.github\/ci-path-classifier\.js/);
  assert.match(workflow, /\n {2}node-check:\n[\s\S]*?needs: classify/);
  assert.match(workflow, /\n {2}rust-check:\n[\s\S]*?needs: classify/);
  assert.match(workflow, /\n {2}required:\n[\s\S]*?name: required/);
  assert.match(workflow, /RUST_DOCKER_RESULT: \$\{\{ needs\.rust-docker\.result \}\}/);
  assert.match(workflow, /if \[\[ "\$NODE_SELECTED" == "true" \]\]/);
  assert.match(workflow, /if \[\[ "\$RUST_SELECTED" == "true" \]\]/);
  assert.doesNotMatch(triggers, /^\s+paths(?:-ignore)?:/m);
  assert.match(codeql, /node \.github\/ci-path-classifier\.js/);
  assert.match(codeql, /\n {2}analyze:\n[\s\S]*?needs: classify/);
  assert.match(codeql, /\n {2}required:\n[\s\S]*?name: Analyze JavaScript\/TypeScript/);
});
