#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * Packs the repo, extracts the tarball into a scratch `node_modules/@the-open-engine/zeroshot`
 * (rather than running a real `npm install`, which would redundantly re-resolve every dependency
 * this repo already has installed), and symlinks every OTHER package from the repo's own
 * `node_modules` alongside it so the extracted package's real dependencies (`ws` for `./cluster`,
 * plus everything the default entrypoint needs) resolve. This exercises Node's real `exports`-map
 * resolution through a bare specifier — a relative `require()` of the extracted files would bypass
 * the exports map entirely and prove nothing about AC7.
 */
function packAndInstallInto(consumerDir) {
  const packOutputRaw = run('npm', ['pack', '--json', '--pack-destination', os.tmpdir()], {
    cwd: repoRoot,
  });
  const packResults = JSON.parse(packOutputRaw);
  const tarballPath = path.join(os.tmpdir(), packResults[0].filename);

  const consumerNodeModules = path.join(consumerDir, 'node_modules');
  const scopeDir = path.join(consumerNodeModules, '@the-open-engine');
  const packageDir = path.join(scopeDir, 'zeroshot');
  fs.mkdirSync(scopeDir, { recursive: true });
  run('tar', ['xzf', tarballPath, '-C', scopeDir]);
  fs.renameSync(path.join(scopeDir, 'package'), packageDir);
  fs.rmSync(tarballPath, { force: true });

  const repoNodeModules = path.join(repoRoot, 'node_modules');
  for (const entry of fs.readdirSync(repoNodeModules)) {
    if (entry === '@the-open-engine' || entry === '.bin') continue;
    fs.symlinkSync(path.join(repoNodeModules, entry), path.join(consumerNodeModules, entry), 'dir');
  }

  return packageDir;
}

function writeAndRun(consumerDir, filename, source) {
  const filePath = path.join(consumerDir, filename);
  fs.writeFileSync(filePath, source);
  return run('node', [filePath], { cwd: consumerDir });
}

function main() {
  const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cluster-package-'));
  try {
    const packageDir = packAndInstallInto(consumerDir);

    const cjsOutput = writeAndRun(
      consumerDir,
      'require-probe.cjs',
      `
        const assert = require('node:assert/strict');
        const cluster = require('@the-open-engine/zeroshot/cluster');
        assert.equal(typeof cluster.ClusterClient, 'function');
        assert.equal(typeof cluster.WebSocketTransport, 'function');
        assert.equal(typeof cluster.DurableWatchClient, 'function');
        assert.equal(typeof cluster.connectCluster, 'function');

        const defaultEntry = require('@the-open-engine/zeroshot');
        assert.ok(defaultEntry, 'default entrypoint must still resolve');

        const deepImport = require('@the-open-engine/zeroshot/lib/cluster-worker/index.js');
        assert.ok(deepImport, 'pre-existing deep import must still resolve unchanged');

        console.log('CJS_PROBE_OK');
      `
    );
    assert.match(cjsOutput, /CJS_PROBE_OK/, `CJS probe failed:\n${cjsOutput}`);

    const esmOutput = writeAndRun(
      consumerDir,
      'import-probe.mjs',
      `
        import assert from 'node:assert/strict';
        import * as cluster from '@the-open-engine/zeroshot/cluster';
        assert.equal(typeof cluster.ClusterClient, 'function');
        assert.equal(typeof cluster.DurableWatchClient, 'function');
        console.log('ESM_PROBE_OK');
      `
    );
    assert.match(esmOutput, /ESM_PROBE_OK/, `ESM probe failed:\n${esmOutput}`);

    const dtsPath = path.join(packageDir, 'lib', 'cluster', 'types', 'index.d.ts');
    assert.ok(fs.existsSync(dtsPath), `missing published type declarations: ${dtsPath}`);
    const dtsContent = fs.readFileSync(dtsPath, 'utf8');
    assert.match(dtsContent, /ClusterClient/, 'published .d.ts does not reference ClusterClient');

    console.log('test:cluster-package passed');
  } finally {
    fs.rmSync(consumerDir, { recursive: true, force: true });
  }
}

main();
