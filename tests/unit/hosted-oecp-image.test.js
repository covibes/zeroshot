'use strict';

const assert = require('assert');
const fs = require('fs');
const nodePath = require('path');
const {
  immutableBaseImages,
  validTag,
  validateContextAllowlist,
  validateImageMetadata,
  validateRuntimeInspection,
} = require('../../scripts/hosted-oecp-image-commands');

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

function imageMetadata() {
  return {
    User: '0:10002',
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
      commandCleanupOwnership: true,
      deliveryContract: true,
      engineStart: true,
      legacyEngine: true,
      ompConfigOverlay: true,
      runtimeDependencies: true,
      orchestrator: true,
      ompRuntime: true,
      ompRuntimeIdentities: true,
      ompRuntimeLock: true,
      ompRuntimeRelease: true,
      worktreeClaudeConfig: true,
      worktreeToolingEnv: true,
    },
    serverExecutable: true,
    tiniExecutable: true,
    gitExecutable: true,
    zeroshotExecutable: true,
    gitAskpassExecutable: true,
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
  it('validates root supervisor and complete runtime modules', function () {
    assert.doesNotThrow(() => validateImageMetadata(imageMetadata()));
    assert.doesNotThrow(() => validateRuntimeInspection(runtimeInspection()));

    const nonRoot = imageMetadata();
    nonRoot.User = '10001:10001';
    assert.throws(() => validateImageMetadata(nonRoot), /supervisor identity is invalid/);

    const nonRootControl = runtimeInspection();
    nonRootControl.controlRoot.uid = 1000;
    assert.throws(() => validateRuntimeInspection(nonRootControl), /root-owned and private/);

    const missingPort = imageMetadata();
    delete missingPort.ExposedPorts['8084/tcp'];
    assert.throws(() => validateImageMetadata(missingPort), /unexpected port/);

    const extraPort = imageMetadata();
    extraPort.ExposedPorts['8086/tcp'] = {};
    assert.throws(() => validateImageMetadata(extraPort), /unexpected port/);

    const missingModule = runtimeInspection();
    missingModule.runtimeModules.runtimeDependencies = false;
    assert.throws(() => validateRuntimeInspection(missingModule), /required runtime module/);

    const missingOmpRuntime = runtimeInspection();
    missingOmpRuntime.runtimeModules.ompRuntimeRelease = false;
    assert.throws(() => validateRuntimeInspection(missingOmpRuntime), /required runtime module/);

    const missingProviderDependency = runtimeInspection();
    missingProviderDependency.runtimeModules.commandCleanupOwnership = false;
    assert.throws(
      () => validateRuntimeInspection(missingProviderDependency),
      /required runtime module/
    );

    const vulnerableUndici = runtimeInspection();
    vulnerableUndici.undiciVersion = '8.5.0';
    assert.throws(
      () => validateRuntimeInspection(vulnerableUndici),
      /runtime contents are invalid/
    );

    const nonExecutableAskpass = runtimeInspection();
    nonExecutableAskpass.gitAskpassExecutable = false;
    assert.throws(
      () => validateRuntimeInspection(nonExecutableAskpass),
      /runtime contents are invalid/
    );
  });

  registerPackageManagerInspectionTest();
}

function registerBuildInputTests() {
  it('requires immutable base images and deny-all allowlist parity', function () {
    const baseImages = immutableBaseImages();
    assert.deepStrictEqual(
      baseImages.map(({ stage }) => stage),
      ['rust-build', 'node-deps', 'tini', 'runtime']
    );
    for (const { reference } of baseImages) {
      assert.match(reference, /@sha256:[a-f0-9]{64}$/);
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

  it('installs the CA bundle used by hosted Git', function () {
    const dockerfile = fs.readFileSync(
      nodePath.join(__dirname, '..', '..', 'docker', 'zeroshot-oecp', 'Dockerfile'),
      'utf8'
    );
    assert.match(dockerfile, /apt-get install -y --no-install-recommends ca-certificates git/);
  });
}

describe('hosted OECP image contracts', function () {
  registerImageReferenceTests();
  registerRuntimeInspectionTests();
  registerBuildInputTests();
});
