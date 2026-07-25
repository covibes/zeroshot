'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');
const tmpRoots = [];

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function runNpmPackDryRun() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'silent',
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout);
  return pack;
}

function packTarball(destDir) {
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', destDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'silent',
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const [{ filename }] = JSON.parse(result.stdout);
  return path.join(destDir, filename);
}

/** Extracts the packed tarball into `fixtureDir/node_modules/@the-open-engine/zeroshot`, without running `npm install` (no network, no transitive deps needed for pure resolution/import checks). */
function extractPackageInto(tarballPath, fixtureDir) {
  const targetDir = path.join(fixtureDir, 'node_modules', '@the-open-engine', 'zeroshot');
  fs.mkdirSync(targetDir, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarballPath, '-C', targetDir, '--strip-components=1'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return targetDir;
}

const tarballDir = mkTmpDir('zeroshot-cluster-pack-');
const tarballPath = packTarball(tarballDir);

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm pack includes the built cluster CJS/ESM output and package.json markers', () => {
  const pack = runNpmPackDryRun();
  const files = new Set(pack.files.map((file) => file.path));

  for (const requiredFile of [
    'lib/cluster/cjs/index.js',
    'lib/cluster/cjs/index.d.ts',
    'lib/cluster/cjs/package.json',
    'lib/cluster/esm/index.js',
    'lib/cluster/esm/index.d.ts',
    'lib/cluster/esm/package.json',
  ]) {
    assert.ok(files.has(requiredFile), `npm package must include ${requiredFile}`);
  }
});

test('a packed tarball resolves "@the-open-engine/zeroshot/cluster" for CommonJS require and runs a real call', () => {
  const fixtureDir = mkTmpDir('zeroshot-cluster-cjs-');
  extractPackageInto(tarballPath, fixtureDir);

  const fixtureFile = path.join(fixtureDir, 'index.cjs');
  fs.writeFileSync(
    fixtureFile,
    `
    const assert = require('node:assert/strict');
    const {connectCluster, ClusterClient} = require('@the-open-engine/zeroshot/cluster');

    class FakeSocket {
      constructor() {
        this.readyState = 1;
        this.listeners = {};
      }
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
      }
      emit(type, event) {
        for (const fn of (this.listeners[type] || []).slice()) fn(event);
      }
      send(data) {
        const request = JSON.parse(data);
        if (request.method !== 'initialize') return;
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: 'openengine.cluster/v1',
            capabilities: {},
            status: {phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null},
          },
        });
        queueMicrotask(() => this.emit('message', {data: response}));
      }
      close() {
        this.readyState = 3;
        this.emit('close', {code: 1000, reason: ''});
      }
    }

    (async () => {
      const socket = new FakeSocket();
      const connection = await connectCluster('ws://fixture.invalid', {
        webSocketFactory: () => {
          queueMicrotask(() => socket.emit('open', {}));
          return socket;
        },
      });
      assert.ok(connection.client instanceof ClusterClient);
      const result = await connection.client.initialize();
      assert.equal(result.protocolVersion, 'openengine.cluster/v1');
      connection.close();
      console.log('CJS_FIXTURE_OK');
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    `
  );

  const result = spawnSync(process.execPath, [fixtureFile], { cwd: fixtureDir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CJS_FIXTURE_OK/);
});

test('a packed tarball resolves "@the-open-engine/zeroshot/cluster" for ESM import and runs a real call', () => {
  const fixtureDir = mkTmpDir('zeroshot-cluster-esm-');
  extractPackageInto(tarballPath, fixtureDir);

  const fixtureFile = path.join(fixtureDir, 'index.mjs');
  fs.writeFileSync(
    fixtureFile,
    `
    import assert from 'node:assert/strict';
    import {connectCluster, ClusterClient} from '@the-open-engine/zeroshot/cluster';

    class FakeSocket {
      constructor() {
        this.readyState = 1;
        this.listeners = {};
      }
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
      }
      emit(type, event) {
        for (const fn of (this.listeners[type] || []).slice()) fn(event);
      }
      send(data) {
        const request = JSON.parse(data);
        if (request.method !== 'initialize') return;
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: 'openengine.cluster/v1',
            capabilities: {},
            status: {phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null},
          },
        });
        queueMicrotask(() => this.emit('message', {data: response}));
      }
      close() {
        this.readyState = 3;
        this.emit('close', {code: 1000, reason: ''});
      }
    }

    const socket = new FakeSocket();
    const connection = await connectCluster('ws://fixture.invalid', {
      webSocketFactory: () => {
        queueMicrotask(() => socket.emit('open', {}));
        return socket;
      },
    });
    assert.ok(connection.client instanceof ClusterClient);
    const result = await connection.client.initialize();
    assert.equal(result.protocolVersion, 'openengine.cluster/v1');
    connection.close();
    console.log('ESM_FIXTURE_OK');
    `
  );

  const result = spawnSync(process.execPath, [fixtureFile], { cwd: fixtureDir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ESM_FIXTURE_OK/);
});

test('a packed tarball resolves "@the-open-engine/zeroshot/cluster" types for a TypeScript consumer', () => {
  const fixtureDir = mkTmpDir('zeroshot-cluster-ts-');
  extractPackageInto(tarballPath, fixtureDir);

  fs.writeFileSync(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'cluster-ts-fixture', private: true }, null, 2)
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        files: ['index.ts'],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'index.ts'),
    `
    import {connectCluster, ClusterClient, type ClusterConnection, type ConnectClusterOptions} from '@the-open-engine/zeroshot/cluster';

    function clientOf(connection: ClusterConnection): ClusterClient {
      return connection.client;
    }

    const options: ConnectClusterOptions = {};

    void connectCluster;
    void clientOf;
    void options;
    `
  );

  const tscPath = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(tscPath, ['-p', path.join(fixtureDir, 'tsconfig.json')], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stdout || result.stderr);
});

test('the pre-existing default entrypoint and a pre-existing deep import still resolve unchanged', () => {
  const fixtureDir = mkTmpDir('zeroshot-cluster-legacy-');
  extractPackageInto(tarballPath, fixtureDir);

  const fixtureFile = path.join(fixtureDir, 'check.cjs');
  fs.writeFileSync(
    fixtureFile,
    `
    const assert = require('node:assert/strict');
    assert.equal(
      require.resolve('@the-open-engine/zeroshot'),
      require.resolve('@the-open-engine/zeroshot/src/orchestrator.js')
    );
    require.resolve('@the-open-engine/zeroshot/lib/cluster-worker/index.js');
    require.resolve('@the-open-engine/zeroshot/package.json');
    console.log('LEGACY_FIXTURE_OK');
    `
  );

  const result = spawnSync(process.execPath, [fixtureFile], { cwd: fixtureDir, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LEGACY_FIXTURE_OK/);
});
