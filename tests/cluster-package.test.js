/**
 * Packaging smoke tests for the `@the-open-engine/zeroshot/cluster` subpath: a real `npm pack`
 * tarball installed into three scratch consumer projects (CommonJS, ESM, TypeScript), verifying
 * the subpath resolves and works end-to-end, and that the existing default entrypoint plus a
 * pre-existing deep import still resolve unchanged. Mirrors tests/package-smoke.test.js.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'error',
    },
    ...options,
  });
  assert.strictEqual(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`
  );
  return result;
}

describe('npm package smoke: cluster subpath', function () {
  this.timeout(60000);

  let tmpRoot;
  let tarballPath;

  before(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cluster-pack-'));
    run('npm', ['pack', '--pack-destination', tmpRoot, '--silent'], { cwd: repoRoot });
    const tarballName = fs.readdirSync(tmpRoot).find((file) => file.endsWith('.tgz'));
    assert.ok(tarballName, 'npm pack did not produce a tarball');
    tarballPath = path.join(tmpRoot, tarballName);
  });

  after(function () {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('npm pack --dry-run --json includes the built cluster subpath artifacts', function () {
    const result = run('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot });
    const [pack] = JSON.parse(result.stdout);
    const files = new Set(pack.files.map((file) => file.path));
    for (const required of [
      'lib/cluster/index.js',
      'lib/cluster/index.d.ts',
      'lib/cluster/esm/index.mjs',
    ]) {
      assert.ok(files.has(required), `npm package must include ${required}`);
    }
  });

  function installTarballInto(dirName, packageJson) {
    const dir = path.join(tmpRoot, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson));
    run('npm', ['install', tarballPath, '--no-save', '--ignore-scripts', '--prefer-offline'], {
      cwd: dir,
    });
    return dir;
  }

  it('a packed CommonJS consumer can require() the cluster subpath, and the default entrypoint plus a deep import still resolve', function () {
    const dir = installTarballInto('cjs-consumer', {
      name: 'cjs-consumer',
      version: '1.0.0',
      private: true,
    });
    const result = run(
      'node',
      [
        '-e',
        `
        const cluster = require('@the-open-engine/zeroshot/cluster');
        if (typeof cluster.ClusterClient !== 'function') throw new Error('ClusterClient missing');
        if (typeof cluster.createWebSocketTransport !== 'function') throw new Error('createWebSocketTransport missing');
        if (cluster.PROTOCOL_VERSION !== 'openengine.cluster/v1') throw new Error('unexpected PROTOCOL_VERSION');
        require.resolve('@the-open-engine/zeroshot');
        require.resolve('@the-open-engine/zeroshot/cli/index.js');
        console.log('OK');
      `,
      ],
      { cwd: dir }
    );
    assert.strictEqual(result.stdout.trim(), 'OK');
  });

  it('a packed ESM consumer can import the cluster subpath', function () {
    const dir = installTarballInto('esm-consumer', {
      name: 'esm-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
    });
    fs.writeFileSync(
      path.join(dir, 'check.mjs'),
      `
      import { ClusterClient, PROTOCOL_VERSION } from '@the-open-engine/zeroshot/cluster';
      if (typeof ClusterClient !== 'function') throw new Error('ClusterClient missing');
      if (PROTOCOL_VERSION !== 'openengine.cluster/v1') throw new Error('unexpected PROTOCOL_VERSION');
      console.log('OK');
      `
    );
    const result = run('node', ['check.mjs'], { cwd: dir });
    assert.strictEqual(result.stdout.trim(), 'OK');
  });

  it('a packed TypeScript consumer can import and typecheck against the cluster subpath', function () {
    const dir = installTarballInto('ts-consumer', {
      name: 'ts-consumer',
      version: '1.0.0',
      private: true,
    });
    fs.writeFileSync(
      path.join(dir, 'check.ts'),
      `
      import { ClusterClient, PROTOCOL_VERSION, type ClusterCallOptions } from '@the-open-engine/zeroshot/cluster';
      const client: ClusterClient = new ClusterClient({ request: async () => '{}' });
      const options: ClusterCallOptions = {};
      console.log(PROTOCOL_VERSION, typeof client, options);
      `
    );
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['check.ts'],
      })
    );
    const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
    run(tscBin, ['--project', 'tsconfig.json'], { cwd: dir });
  });
});
