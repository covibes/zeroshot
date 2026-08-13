const {
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  assert,
  exactRuntimeOptions,
  fakePackageRoot,
  metadataReader,
  path,
  resolveOmpSdkContainerRuntime,
  resolveOmpSdkRuntime,
} = require('./helpers/release-preflight-harness');

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
      path.join(fakePackageRoot, 'scripts', 'omp', 'sidecar.ts')
    );
    assert.strictEqual(
      runtime.hostSupervisorPath,
      path.join(fakePackageRoot, 'scripts', 'omp', 'host-supervisor.ts')
    );
    assert.strictEqual(runtime.bunPlatformPackage, '@oven/bun-linux-x64');
    assert.strictEqual(runtime.ompNativePlatformPackage, '@oh-my-pi/pi-natives-linux-x64');
    assert.strictEqual(runtime.ompVersion, '17.2.1');
    assert.strictEqual(runtime.bunVersion, '1.3.14');
  });

  it('defers containment proof to the active invocation inside a container', () => {
    const runtime = resolveOmpSdkContainerRuntime({
      ...exactRuntimeOptions,
      readContainmentProbe() {
        throw new Error('the image inspection process is not an active provider invocation');
      },
    });

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
