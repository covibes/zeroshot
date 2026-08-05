'use strict';

const assert = require('assert');
const {
  validTag,
  validateImageMetadata,
  validateRuntimeInspection,
} = require('../../scripts/hosted-oecp-image-commands');
const {
  createManifest,
  immutableBaseImages,
  validateContextAllowlist,
} = require('../../scripts/hosted-oecp-manifest');

const packageManagerPaths = [
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/bin/corepack',
  '/usr/local/bin/yarn',
  '/usr/local/bin/yarnpkg',
  '/usr/local/bin/pnpm',
  '/usr/local/bin/pnpx',
  '/usr/local/lib/node_modules/npm',
  '/usr/local/lib/node_modules/corepack',
  '/opt/yarn-v1.22.22',
];

function absentPackageManagerPaths() {
  return Object.fromEntries(packageManagerPaths.map((path) => [path, false]));
}

function imageMetadata(manifestDigest) {
  return {
    User: '0:10002',
    Labels: { 'org.opencontainers.image.revision': manifestDigest },
    Entrypoint: [
      '/usr/bin/tini',
      '-s',
      '--',
      '/usr/local/bin/node',
      '/opt/zeroshot/zeroshot-rust/hosted-node/capsule-entrypoint.js',
    ],
    ExposedPorts: { '8083/tcp': {}, '8084/tcp': {}, '8085/tcp': {} },
    Env: ['ZEROSHOT_OECP_CAPABILITY_FILE=/run/zeroshot-capsule-agent/capability'],
  };
}

function runtimeInspection() {
  return {
    uid: 0,
    gid: 10002,
    worker: { uid: 10002, gid: 10002 },
    workspace: { uid: 10002, gid: 10002, mode: '770' },
    controlRoot: { uid: 0, gid: 10002, mode: '700' },
    forbiddenPresent: [],
    packageManagerPaths: absentPackageManagerPaths(),
    runtimeModules: {
      engineStart: true,
      runtimeDependencies: true,
      ompRuntime: true,
      ompRuntimeIdentities: true,
      ompRuntimeLock: true,
      ompRuntimeRelease: true,
    },
    serverExecutable: true,
    tiniExecutable: true,
    gitExecutable: true,
    ajvVersion: '8.18.0',
    undiciVersion: '8.9.0',
  };
}

function registerPackageManagerInspectionTest() {
  it('requires an exact absent package manager path inspection', function () {
    const expectedPaths = absentPackageManagerPaths();
    assert.deepStrictEqual(runtimeInspection().packageManagerPaths, expectedPaths);

    for (const target of packageManagerPaths) {
      const present = runtimeInspection();
      present.packageManagerPaths[target] = true;
      assert.throws(() => validateRuntimeInspection(present), /package manager paths are invalid/);
    }

    const missing = runtimeInspection();
    delete missing.packageManagerPaths['/usr/local/bin/npm'];
    assert.throws(() => validateRuntimeInspection(missing), /package manager paths are invalid/);

    const extra = runtimeInspection();
    extra.packageManagerPaths['/usr/local/bin/bun'] = false;
    assert.throws(() => validateRuntimeInspection(extra), /package manager paths are invalid/);
  });
}

function manifestRuntimeContract() {
  return {
    supervisor: { user: 'root', uid: 0, gid: 10002 },
    controlRoot: {
      path: '/run/zeroshot-capsule-agent',
      user: 'root',
      uid: 0,
      gid: 10002,
      mode: '0700',
    },
    transports: {
      ndjson: {
        protocol: 'ndjson',
        scope: 'task-local',
        port: 8085,
      },
      websocket: {
        protocol: 'websocket',
        scope: 'capsule-agent',
        route: '/oecp',
        port: 8083,
      },
      runIntent: {
        protocol: 'http',
        scope: 'internal',
        route: '/internal/run-intents/{intent_id}',
        port: 8084,
      },
    },
  };
}

function registerImageReferenceTests() {
  it('accepts Docker references with registry ports without accepting option or shell injection', function () {
    const accepted = [
      'zeroshot-oecp:private',
      'registry.example.com:5000/team/zeroshot-oecp:private',
      'localhost:5000/zeroshot-oecp',
      '[2001:db8::1]:5000/team/zeroshot-oecp:private',
      `registry.example.com/team/zeroshot-oecp@sha256:${'a'.repeat(64)}`,
    ];
    const rejected = [
      '--help',
      'registry.example.com:5000/Team/image:private',
      'registry.example.com:5000/team/image;touch-pwned',
      'registry.example.com:5000/team/image private',
      'registry.example.com:5000/team/image:bad/tag',
      'registry.example.com:port/team/image',
      `image@sha256:${'a'.repeat(31)}`,
    ];
    for (const reference of accepted) assert.strictEqual(validTag(reference), true, reference);
    for (const reference of rejected) assert.strictEqual(validTag(reference), false, reference);
  });
}

function registerRuntimeInspectionTests() {
  it('validates exact revision, root supervisor, and complete runtime modules', function () {
    const digest = 'manifest-digest';
    assert.doesNotThrow(() => validateImageMetadata(imageMetadata(digest), digest));
    assert.doesNotThrow(() => validateRuntimeInspection(runtimeInspection()));

    const wrongRevision = imageMetadata('different-digest');
    assert.throws(
      () => validateImageMetadata(wrongRevision, digest),
      /OCI revision does not match/
    );

    const nonRoot = imageMetadata(digest);
    nonRoot.User = '10001:10001';
    assert.throws(() => validateImageMetadata(nonRoot, digest), /supervisor identity is invalid/);

    const nonRootControl = runtimeInspection();
    nonRootControl.controlRoot.uid = 1000;
    assert.throws(() => validateRuntimeInspection(nonRootControl), /root-owned and private/);

    const missingPort = imageMetadata(digest);
    delete missingPort.ExposedPorts['8084/tcp'];
    assert.throws(() => validateImageMetadata(missingPort, digest), /unexpected port/);

    const extraPort = imageMetadata(digest);
    extraPort.ExposedPorts['8086/tcp'] = {};
    assert.throws(() => validateImageMetadata(extraPort, digest), /unexpected port/);

    const missingModule = runtimeInspection();
    missingModule.runtimeModules.runtimeDependencies = false;
    assert.throws(() => validateRuntimeInspection(missingModule), /required runtime module/);

    const missingOmpRuntime = runtimeInspection();
    missingOmpRuntime.runtimeModules.ompRuntimeRelease = false;
    assert.throws(() => validateRuntimeInspection(missingOmpRuntime), /required runtime module/);

    const vulnerableUndici = runtimeInspection();
    vulnerableUndici.undiciVersion = '8.5.0';
    assert.throws(
      () => validateRuntimeInspection(vulnerableUndici),
      /runtime contents are invalid/
    );
  });

  registerPackageManagerInspectionTest();
}

function registerManifestTests() {
  it('records immutable image identities and enforces deny-all allowlist parity', function () {
    const manifest = createManifest();
    assert.strictEqual(manifest.schemaVersion, 3);
    assert.strictEqual(Object.hasOwn(manifest.protocol, 'route'), false);
    assert.strictEqual(Object.hasOwn(manifest.runtime, 'port'), false);
    const runtimeContract = manifestRuntimeContract();
    assert.deepStrictEqual(manifest.runtime.supervisor, runtimeContract.supervisor);
    assert.deepStrictEqual(manifest.runtime.controlRoot, runtimeContract.controlRoot);
    assert.deepStrictEqual(manifest.runtime.transports, runtimeContract.transports);
    assert.deepStrictEqual(
      manifest.image.baseImages.map(({ stage }) => stage),
      ['rust-build', 'node-deps', 'tini', 'runtime']
    );
    for (const { reference } of manifest.image.baseImages) {
      assert.match(reference, /@sha256:[a-f0-9]{64}$/);
    }
    assert.strictEqual(typeof manifest.inputs['docker/zeroshot-oecp/.dockerignore'], 'string');
    assert.strictEqual(
      typeof manifest.inputs['docker/zeroshot-oecp/Dockerfile.dockerignore'],
      'string'
    );
    for (const runtimeModule of [
      'scripts/omp/runtime.js',
      'scripts/omp/runtime-identities.js',
      'scripts/omp/runtime-lock.js',
      'scripts/omp/runtime-release.js',
    ]) {
      assert.strictEqual(typeof manifest.inputs[runtimeModule], 'string');
    }

    const denyAll = '**\n!Cargo.lock\n';
    assert.doesNotThrow(() => validateContextAllowlist(denyAll, denyAll));
    assert.throws(
      () => validateContextAllowlist(denyAll, '**\n!Cargo.toml\n'),
      /allowlist drifted/
    );
    assert.throws(() => validateContextAllowlist('!Cargo.lock\n', '!Cargo.lock\n'), /deny-all/);
    assert.throws(() => immutableBaseImages('FROM node:22-bookworm-slim'), /not immutable/);
  });
}

describe('hosted OECP image contracts', function () {
  registerImageReferenceTests();
  registerRuntimeInspectionTests();
  registerManifestTests();
});
