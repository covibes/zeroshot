const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REQUIRED_OMP_SDK_SOURCES,
  analyzeMessage,
  maxReleaseType,
  releaseTypeForMessages,
  validateOmpSdkReleaseAssets,
  validateReleaseConfig,
} = require('../scripts/release-preflight');
const {
  BUN_RUNTIME_VERSION,
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  OMP_SDK_VERSION,
  resolveOmpSdkRuntime,
} = require('../scripts/omp-sdk-runtime');

const repositoryRoot = path.join(__dirname, '..');
const fakePackageRoot = path.resolve('/package');
const exactPackageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
);
const exactPackageLock = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')
);
const exactPackageShrinkwrap = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'npm-shrinkwrap.json'), 'utf8')
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runtimeMetadata(packageName, version) {
  return {
    packageJsonPath: path.join(
      fakePackageRoot,
      'node_modules',
      ...packageName.split('/'),
      'package.json'
    ),
    manifest: { name: packageName, version },
  };
}

function validateAssets({
  packageJson = exactPackageJson,
  packageLock = exactPackageLock,
  packageLockSource,
  packageShrinkwrap = exactPackageShrinkwrap,
  packageShrinkwrapSource,
  sourceFiles = REQUIRED_OMP_SDK_SOURCES,
} = {}) {
  return validateOmpSdkReleaseAssets(packageJson, packageLock, {
    packageLockSource,
    packageShrinkwrap,
    packageShrinkwrapSource,
    sourceFiles: [...sourceFiles],
  });
}

function metadataReader(versions = {}) {
  return (packageName) => {
    const exactVersion = packageName.startsWith('@oh-my-pi/')
      ? OMP_SDK_VERSION
      : BUN_RUNTIME_VERSION;
    return runtimeMetadata(packageName, versions[packageName] || exactVersion);
  };
}

const exactRuntimeOptions = Object.freeze({
  packageRoot: '/package',
  platform: 'linux',
  arch: 'x64',
  readPackageMetadata: metadataReader(),
  fileExists: () => true,
  readRuntimeVersion: () => BUN_RUNTIME_VERSION,
  readContainmentProbe: () =>
    JSON.stringify({
      protocolVersion: 1,
      type: 'cleanup-attestation',
      status: 'clean',
      mode: 'linux-subreaper-pidfd',
      subreaper: true,
      pidfd: true,
      terminalBuffered: true,
      ownedProcessCount: 0,
      cancelled: false,
      semantic: { exitCode: 0, signal: null },
    }),
});

describe('release preflight', () => {
  it('does not retain the retired release-promotion commit type', () => {
    assert.strictEqual(analyzeMessage('release: promote dev to main'), null);
    assert.strictEqual(analyzeMessage('release(main): promote dev to main'), null);
  });

  it('classifies conventional breaking commits as majors', () => {
    assert.strictEqual(analyzeMessage('feat!: replace release flow'), 'major');
    assert.strictEqual(
      analyzeMessage('fix: repair release\n\nBREAKING CHANGE: config moved'),
      'major'
    );
  });

  it('preserves the highest release type found', () => {
    assert.strictEqual(maxReleaseType('patch', 'minor'), 'minor');
    assert.strictEqual(maxReleaseType('minor', 'patch'), 'minor');
    assert.strictEqual(maxReleaseType('minor', 'major'), 'major');
  });

  it('allows trunk commits that intentionally produce no publication', () => {
    assert.strictEqual(
      releaseTypeForMessages(['docs: clarify setup', 'chore: refresh fixtures']),
      null
    );
    assert.strictEqual(
      releaseTypeForMessages(['docs: clarify setup', 'fix: repair attach']),
      'patch'
    );
  });
});

describe('release configuration', () => {
  it('rejects branch-writing plugins in the effective release config', () => {
    assert.throws(
      () =>
        validateReleaseConfig({
          release: {
            branches: ['main'],
            plugins: [
              '@semantic-release/commit-analyzer',
              './scripts/semantic-release-notes.js',
              ['@semantic-release/npm', { npmPublish: true }],
              '@semantic-release/git',
              '@semantic-release/github',
            ],
          },
        }),
      /must not be in the effective release config/
    );
  });

  it('rejects custom analyzer rules that would distort semantic versioning', () => {
    assert.throws(
      () =>
        validateReleaseConfig({
          release: {
            branches: ['main'],
            plugins: [
              [
                '@semantic-release/commit-analyzer',
                { releaseRules: [{ type: 'release', release: 'minor' }] },
              ],
              './scripts/semantic-release-notes.js',
              ['@semantic-release/npm', { npmPublish: true }],
              '@semantic-release/github',
            ],
          },
        }),
      /standard conventional release rules/
    );
  });

  it('accepts the protected-main release config', () => {
    const plugins = validateReleaseConfig({
      release: {
        branches: ['main'],
        plugins: [
          '@semantic-release/commit-analyzer',
          './scripts/semantic-release-notes.js',
          ['@semantic-release/npm', { npmPublish: true }],
          '@semantic-release/github',
        ],
      },
    });

    assert.deepStrictEqual(plugins, [
      '@semantic-release/commit-analyzer',
      './scripts/semantic-release-notes.js',
      '@semantic-release/npm',
      '@semantic-release/github',
    ]);
  });
});

describe('OMP SDK runtime release assets', () => {
  it('accepts the reviewed shrinkwrap closure and only the Bun/OMP platform intersection', () => {
    const identity = validateAssets();

    assert.strictEqual(identity.ompVersion, '17.2.1');
    assert.strictEqual(identity.bunVersion, '1.3.14');
    assert.match(identity.runtimeClosureSha256, /^[a-f0-9]{64}$/);
    assert.match(identity.shrinkwrapSha256, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(identity.supportedPlatforms, ['linux:arm64', 'linux:x64']);
    assert.deepStrictEqual(identity.bunPlatformPackages, [
      '@oven/bun-darwin-aarch64',
      '@oven/bun-darwin-x64',
      '@oven/bun-linux-aarch64',
      '@oven/bun-linux-x64',
      '@oven/bun-windows-x64',
    ]);
    assert.strictEqual(
      exactPackageJson.ompSdkHostContainment.supervisor,
      'scripts/omp-sdk-host-supervisor.ts'
    );
    assert.deepStrictEqual(exactPackageJson.ompSdkHostContainment.platforms, [
      'linux:arm64',
      'linux:x64',
    ]);
  });

  it('rejects dependency, package lock, and mandatory native asset drift', () => {
    const packageJson = clone(exactPackageJson);
    packageJson.dependencies[OMP_PACKAGE_NAME] = '^17.2.1';
    assert.throws(
      () => validateAssets({ packageJson }),
      /package-lock\.json root dependencies must exactly match package\.json/
    );

    const packageLock = clone(exactPackageLock);
    packageLock.packages['node_modules/@oh-my-pi/pi-coding-agent'].integrity = 'sha512-drift';
    assert.throws(
      () => validateAssets({ packageLock }),
      /package-lock\.json @oh-my-pi\/pi-coding-agent integrity drift/
    );

    const nativeLock = clone(exactPackageLock);
    nativeLock.packages['node_modules/@oh-my-pi/pi-natives-linux-x64'].integrity = 'sha512-drift';
    assert.throws(
      () => validateAssets({ packageLock: nativeLock }),
      /package-lock\.json @oh-my-pi\/pi-natives-linux-x64 integrity drift/
    );
  });

  it('rejects missing, root-drifted, and transitively drifted shrinkwraps', () => {
    assert.throws(
      () => validateAssets({ packageShrinkwrap: null }),
      /require published npm-shrinkwrap\.json/
    );

    const rootDrift = clone(exactPackageShrinkwrap);
    rootDrift.packages[''].dependencies.ajv = '^8.17.0';
    assert.throws(
      () => validateAssets({ packageShrinkwrap: rootDrift }),
      /npm-shrinkwrap\.json root dependencies must exactly match package\.json/
    );

    const runtimeDrift = clone(exactPackageShrinkwrap);
    runtimeDrift.packages['node_modules/@babel/parser'].integrity = 'sha512-drift';
    assert.throws(
      () => validateAssets({ packageShrinkwrap: runtimeDrift }),
      /runtime closure identity must exactly match package-lock\.json/
    );

    const digestDrift = clone(exactPackageShrinkwrap);
    digestDrift.packages['node_modules/@commitlint/cli'].integrity = 'sha512-drift';
    assert.throws(
      () => validateAssets({ packageShrinkwrap: digestDrift }),
      /npm-shrinkwrap\.json digest must exactly match package-lock\.json/
    );

    assert.throws(
      () =>
        validateAssets({
          packageLockSource: 'reviewed lock bytes',
          packageShrinkwrapSource: 'mutated shrinkwrap bytes',
        }),
      /published npm-shrinkwrap\.json byte digest must exactly match package-lock\.json/
    );
  });

  it('rejects missing sidecar, shrinkwrap, and publish allowlist coverage', () => {
    assert.throws(
      () => validateAssets({ sourceFiles: ['scripts/omp-sdk-runtime.js'] }),
      /OMP SDK release source is missing: scripts\/omp-sdk-sidecar\.ts/
    );
    assert.throws(
      () =>
        validateAssets({
          sourceFiles: ['scripts/omp-sdk-runtime.js', 'scripts/omp-sdk-sidecar.ts'],
        }),
      /OMP SDK release source is missing: scripts\/omp-sdk-host-supervisor\.ts/
    );

    const packageJson = clone(exactPackageJson);
    packageJson.files = packageJson.files.filter((entry) => entry !== 'scripts/');
    assert.throws(
      () => validateAssets({ packageJson }),
      /publish allowlist excludes scripts\/omp-sdk-runtime\.js/
    );

    const shrinkwrapExcluded = clone(exactPackageJson);
    shrinkwrapExcluded.files = shrinkwrapExcluded.files.filter(
      (entry) => entry !== 'npm-shrinkwrap.json'
    );
    assert.throws(
      () => validateAssets({ packageJson: shrinkwrapExcluded }),
      /publish allowlist excludes npm-shrinkwrap\.json/
    );
  });
});

describe('OMP SDK runtime resolver', () => {
  it('resolves the local pinned Bun wrapper and bundled sidecar without a global omp', () => {
    const requestedPackages = [];
    const exactMetadata = metadataReader();
    const runtime = resolveOmpSdkRuntime({
      ...exactRuntimeOptions,
      readPackageMetadata(packageName) {
        requestedPackages.push(packageName);
        return exactMetadata(packageName);
      },
    });

    assert.deepStrictEqual(requestedPackages, [
      '@oh-my-pi/pi-coding-agent',
      '@oh-my-pi/pi-natives',
      '@oh-my-pi/pi-natives-linux-x64',
      'bun',
      '@oven/bun-linux-x64',
    ]);
    assert.strictEqual(
      runtime.bunExecutable,
      path.join(fakePackageRoot, 'node_modules', 'bun', 'bin', 'bun.exe')
    );
    assert.strictEqual(
      runtime.sidecarPath,
      path.join(fakePackageRoot, 'scripts', 'omp-sdk-sidecar.ts')
    );
    assert.strictEqual(
      runtime.hostSupervisorPath,
      path.join(fakePackageRoot, 'scripts', 'omp-sdk-host-supervisor.ts')
    );
    assert.strictEqual(runtime.bunPlatformPackage, '@oven/bun-linux-x64');
    assert.strictEqual(runtime.ompNativePlatformPackage, '@oh-my-pi/pi-natives-linux-x64');
    assert.strictEqual(runtime.ompVersion, '17.2.1');
    assert.strictEqual(runtime.bunVersion, '1.3.14');
  });

  it('rejects every platform outside the Bun/OMP native intersection before package loading', () => {
    for (const [platform, arch] of [
      ['android', 'arm64'],
      ['android', 'x64'],
      ['freebsd', 'arm64'],
      ['freebsd', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'x64'],
      ['aix', 'x64'],
    ]) {
      assert.throws(
        () =>
          resolveOmpSdkRuntime({
            ...exactRuntimeOptions,
            platform,
            arch,
            readPackageMetadata() {
              throw new Error('package loading must not begin');
            },
          }),
        new RegExp(`Unsupported OMP SDK host runtime platform: ${platform}/${arch}`)
      );
    }
  });

  it('fails closed on missing and drifted runtime assets', () => {
    const exactMetadata = metadataReader();

    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readPackageMetadata(packageName) {
            if (packageName === OMP_NATIVE_PLATFORM_PACKAGES['linux:x64']) {
              throw new Error('OMP native platform asset missing');
            }
            return exactMetadata(packageName);
          },
        }),
      /OMP native platform asset missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readPackageMetadata(packageName) {
            if (packageName.startsWith('@oven/')) throw new Error('Bun platform asset missing');
            return exactMetadata(packageName);
          },
        }),
      /Bun platform asset missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readPackageMetadata: metadataReader({ [OMP_PACKAGE_NAME]: '17.2.0' }),
        }),
      /pi-coding-agent version drift/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readPackageMetadata: metadataReader({ [OMP_NATIVE_PACKAGE_NAME]: '17.2.0' }),
        }),
      /pi-natives version drift/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readPackageMetadata: metadataReader({ bun: '1.3.13' }),
        }),
      /Installed bun version drift/
    );
  });
});

describe('OMP SDK runtime asset failures', () => {
  it('fails closed on missing or drifted executable and source assets', () => {
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readRuntimeVersion: () => '1.3.13',
        }),
      /Bun executable version drift/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('src', 'index.ts')),
        }),
      /Pinned OMP SDK entry source is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('bin', 'bun.exe')),
        }),
      /Pinned Bun executable is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith('omp-sdk-sidecar.ts'),
        }),
      /OMP SDK sidecar is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith('omp-sdk-host-supervisor.ts'),
        }),
      /OMP SDK host supervisor is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readContainmentProbe: () =>
            JSON.stringify({
              protocolVersion: 1,
              type: 'cleanup-attestation',
              status: 'clean',
              mode: 'linux-subreaper-pidfd',
              subreaper: true,
              pidfd: true,
              terminalBuffered: true,
              ownedProcessCount: 1,
              cancelled: false,
              semantic: { exitCode: 0, signal: null },
            }),
        }),
      /containment probe returned invalid evidence/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readContainmentProbe: () => '{malformed',
        }),
      /Unable to attest Linux subreaper\/pidfd containment/
    );
  });
});
