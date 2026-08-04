const {
  OMP_PACKAGE_NAME,
  REQUIRED_OMP_SDK_SOURCES,
  assert,
  clone,
  exactPackageJson,
  exactPackageLock,
  exactPackageShrinkwrap,
  validateAssets,
} = require('./helpers/release-preflight-harness');

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
      'scripts/omp/host-supervisor.ts'
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
      () =>
        validateAssets({
          sourceFiles: REQUIRED_OMP_SDK_SOURCES.filter(
            (source) => source !== 'scripts/omp/sidecar.ts'
          ),
        }),
      /OMP SDK release source is missing: scripts\/omp\/sidecar\.ts/
    );
    assert.throws(
      () =>
        validateAssets({
          sourceFiles: REQUIRED_OMP_SDK_SOURCES.filter(
            (source) => source !== 'scripts/omp/host-supervisor.ts'
          ),
        }),
      /OMP SDK release source is missing: scripts\/omp\/host-supervisor\.ts/
    );

    const packageJson = clone(exactPackageJson);
    packageJson.files = packageJson.files.filter((entry) => entry !== 'scripts/');
    assert.throws(
      () => validateAssets({ packageJson }),
      /publish allowlist excludes scripts\/omp\/runtime\.js/
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
