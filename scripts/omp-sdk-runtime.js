'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const OMP_PACKAGE_NAME = '@oh-my-pi/pi-coding-agent';
const OMP_SDK_VERSION = '17.2.1';
const BUN_PACKAGE_NAME = 'bun';
const BUN_RUNTIME_VERSION = '1.3.14';
const SIDECAR_RELATIVE_PATH = path.join('scripts', 'omp-sdk-sidecar.ts');
const HOST_SUPERVISOR_RELATIVE_PATH = path.join('scripts', 'omp-sdk-host-supervisor.ts');
const HOST_SDK_PLATFORM_KEYS = Object.freeze(['linux:arm64', 'linux:x64']);

const BUN_PLATFORM_PACKAGES = Object.freeze({
  'darwin:arm64': '@oven/bun-darwin-aarch64',
  'darwin:x64': '@oven/bun-darwin-x64',
  'linux:arm64': '@oven/bun-linux-aarch64',
  'linux:x64': '@oven/bun-linux-x64',
  'win32:x64': '@oven/bun-windows-x64',
});
const OMP_NATIVE_PACKAGE_NAME = '@oh-my-pi/pi-natives';
const OMP_NATIVE_PLATFORM_PACKAGES = Object.freeze({
  'darwin:arm64': '@oh-my-pi/pi-natives-darwin-arm64',
  'darwin:x64': '@oh-my-pi/pi-natives-darwin-x64',
  'linux:arm64': '@oh-my-pi/pi-natives-linux-arm64',
  'linux:x64': '@oh-my-pi/pi-natives-linux-x64',
  'win32:x64': '@oh-my-pi/pi-natives-win32-x64',
});
const REQUIRED_OMP_SDK_SOURCES = Object.freeze([
  'scripts/omp-sdk-runtime.js',
  SIDECAR_RELATIVE_PATH.replaceAll('\\', '/'),
  HOST_SUPERVISOR_RELATIVE_PATH.replaceAll('\\', '/'),
]);
const OMP_SDK_PACKAGE_INTEGRITY =
  'sha512-Mg1IVCTyxZ+FnYd7AJtqxYEQClfPssgxF1airlFcm4d8j09cfuabh17n+3eprLL3/Un9fe3MOXha1NqICoY4Bg==';
const BUN_PACKAGE_INTEGRITY =
  'sha512-aB6GVd42x1Y5ie1K16SF+oLGtgSkwX9hgoDdIW88pjvfTccU8F1vfpoOt34QLv0dZ1v3XimtaxPlZUG81Gx9Zg==';
const OMP_NATIVE_PACKAGE_INTEGRITY =
  'sha512-74BJXOPPnTKPGG65p6pXIlh1sODwLCntSFh/5sp9GzZN+hcrwTF7kxJGscw2Ky5tQLle7EczlduPALpLOaE0gg==';
const OMP_NATIVE_PLATFORM_ASSET_INTEGRITIES = Object.freeze({
  '@oh-my-pi/pi-natives-darwin-arm64':
    'sha512-V7FcEF/+d/WFTumucykmWwc8fsHzoGYBM0ZvLM3FJMWTl/j+OGe/3ZubsACgdLccKYr2CC61ygXH2RByK8T+HA==',
  '@oh-my-pi/pi-natives-darwin-x64':
    'sha512-INODXqftsj1z3/x4Y/ajHbMY7MFRfUmplnvZc9HoSkmnWW6190frTlX2ZcQYUy7PUDlHCefkePaSGKbyy9HO2g==',
  '@oh-my-pi/pi-natives-linux-arm64':
    'sha512-t1pIfLQp+L7QGR396fPaxvMArm0URjR5PfD3tU6F0VY4HMaS+cSBoLngh0na7SGk+EXnAz1X84kWTrb+Pz7K9w==',
  '@oh-my-pi/pi-natives-linux-x64':
    'sha512-lhJNgkBbMO2wzyAn3zsWtrkZk3UpiSz5lAIpTEHRjZlc/0WwoJ2BTfyg26omROd5Ejio128lmeukM0RuobCTbw==',
  '@oh-my-pi/pi-natives-win32-x64':
    'sha512-N1PZh3E8cyqQMgNfEQbNcneVTUd+1blUpILZDQr+YUraaECr2DdJg350kdFrPHMLKpgKrjaeKj4zn+V/Sx3zRw==',
});
const BUN_PLATFORM_ASSET_INTEGRITIES = Object.freeze({
  '@oven/bun-darwin-aarch64':
    'sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A==',
  '@oven/bun-darwin-x64':
    'sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w==',
  '@oven/bun-darwin-x64-baseline':
    'sha512-OSfsTZstc898HHElhU4NccaBGOSSDn5VfahiVTnidZ9B/+wb7WTyfZJaBeJcfjwJ9H2W9uTh2TGtl3UfcXgV9g==',
  '@oven/bun-freebsd-aarch64':
    'sha512-LIKrXaFxAHybVO5Pf+9XP2FHUj/5APvXTUKk9dqHm5iFz4oH+W24cmhjkJirNujh9hKeTyrpWSe3no9JZKowIw==',
  '@oven/bun-freebsd-x64':
    'sha512-uwD+fGUH1ADpIF3B1U2jWzzb20QwRLZfj5QZ28GUCGrAJ/nTmWrD6YYGsblCY1wuhldRez3lU40AyuvSCyLYmw==',
  '@oven/bun-linux-aarch64':
    'sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==',
  '@oven/bun-linux-aarch64-android':
    'sha512-y4kq5b85lsrmFb9Xvi4w9mA5IEFJkLMrSmYn06q24KjL9rUWDWO3VFZEtteZxUN5+ec3Zm5S8OnJw1umaCbVjA==',
  '@oven/bun-linux-aarch64-musl':
    'sha512-jmqOA92Cd1NL/1XBd4bFkJLxQ86K0RW7ohxS2qzzAvuitO4JiIxjjTeCspoU44zCozH72HpfZfUE2On31OjnWA==',
  '@oven/bun-linux-x64':
    'sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==',
  '@oven/bun-linux-x64-android':
    'sha512-qe9e1d+3VAEU7nAA2ol9Jvmy/o99PVMSgZhHn7Q/9O3YcDrfEqyQ8zm4zoe5qTEo8HZH0dN03Le0Ys2eQPs7eg==',
  '@oven/bun-linux-x64-baseline':
    'sha512-q/8EdOC0yUE8FPeoOVq8/Pw5I9/tJaYmUfO/uDUAREx8IUnOJH1RJ5A3BjFqre8pvJoiZA9AovPJq5FnNNjSxA==',
  '@oven/bun-linux-x64-musl':
    'sha512-GBCB/k/sIqcr06eTNgg7g46qiUv35Jasx4XiccJ/n7RGqrE4RWUD/XJBbWFprVPjvqd59+QtSnS99XGqvftHfg==',
  '@oven/bun-linux-x64-musl-baseline':
    'sha512-n6iE71G4lQE4XkrZhQQcL5YUlxDbnq6nqV7zeQi33PMsLT/0kYE+RvHOtBWZ3w0wMdXZfINmp63hIb9ijUBGtw==',
  '@oven/bun-windows-aarch64':
    'sha512-T7s3x/BsVKQObGU6QDkZeI6wKynzqGbBH1yI77jrrj5siElclxr3DQrDIk8CV4G5/SJq2HHq4kpLyYY2DKCSmA==',
  '@oven/bun-windows-x64':
    'sha512-mUFWL3BoYkNpjd8e9PqROiFF/1Xeotq20mABJsiQH62jM1g5zqWh4khw1RZ6bX8Q8fWvlPaxG1PjofkmjUi3vg==',
  '@oven/bun-windows-x64-baseline':
    'sha512-uIjLUC1S9DWgICzuoMba7vurBJnBruE4S5CxnvmZkdqWVXRzx1Rgu636HoH+k0qeaQCFh3jeG3JQ1y6fRHv0sw==',
});

function defaultReadPackageMetadata(packageName, packageRoot) {
  const packageSegments = packageName.split('/');
  let directory = path.resolve(packageRoot);

  while (true) {
    const packageJsonPath = path.join(
      directory,
      'node_modules',
      ...packageSegments,
      'package.json'
    );
    if (fs.existsSync(packageJsonPath)) {
      return {
        packageJsonPath,
        manifest: JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')),
      };
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Required local package ${packageName} is not installed`);
}

function defaultReadRuntimeVersion(executable) {
  return execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}
function defaultReadContainmentProbe(executable, supervisorPath) {
  return execFileSync(executable, [supervisorPath, '--probe'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function assertPackageIdentity(packageName, expectedVersion, metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`Unable to read installed metadata for ${packageName}`);
  }
  if (!metadata.manifest || metadata.manifest.name !== packageName) {
    throw new Error(`Installed package identity for ${packageName} is invalid`);
  }
  if (metadata.manifest.version !== expectedVersion) {
    throw new Error(
      `Installed ${packageName} version drift: expected ${expectedVersion}, got ${
        metadata.manifest.version || 'unknown'
      }`
    );
  }
  if (typeof metadata.packageJsonPath !== 'string' || metadata.packageJsonPath.length === 0) {
    throw new Error(`Installed package path for ${packageName} is invalid`);
  }
}

function resolveOmpSdkRuntime(options = {}) {
  const runtimeOptions = Object.assign(
    {
      packageRoot: path.join(__dirname, '..'),
      platform: process.platform,
      arch: process.arch,
      fileExists: fs.existsSync,
      readRuntimeVersion: defaultReadRuntimeVersion,
      readContainmentProbe: defaultReadContainmentProbe,
    },
    options
  );
  const packageRoot = path.resolve(runtimeOptions.packageRoot);
  const { platform, arch, fileExists, readRuntimeVersion, readContainmentProbe } = runtimeOptions;
  const readPackageMetadata = runtimeOptions.readPackageMetadata
    ? runtimeOptions.readPackageMetadata
    : (name) => defaultReadPackageMetadata(name, packageRoot);

  const platformKey = `${platform}:${arch}`;
  if (!HOST_SDK_PLATFORM_KEYS.includes(platformKey)) {
    throw new Error(`Unsupported OMP SDK host runtime platform: ${platform}/${arch}`);
  }
  const bunPlatformPackage = BUN_PLATFORM_PACKAGES[platformKey];
  const ompNativePlatformPackage = OMP_NATIVE_PLATFORM_PACKAGES[platformKey];
  if (!bunPlatformPackage || !ompNativePlatformPackage) {
    throw new Error(`Unsupported OMP SDK host runtime platform: ${platform}/${arch}`);
  }

  const ompMetadata = readPackageMetadata(OMP_PACKAGE_NAME);
  const ompNativeMetadata = readPackageMetadata(OMP_NATIVE_PACKAGE_NAME);
  const ompNativePlatformMetadata = readPackageMetadata(ompNativePlatformPackage);
  const bunMetadata = readPackageMetadata(BUN_PACKAGE_NAME);
  const bunPlatformMetadata = readPackageMetadata(bunPlatformPackage);
  assertPackageIdentity(OMP_PACKAGE_NAME, OMP_SDK_VERSION, ompMetadata);
  assertPackageIdentity(OMP_NATIVE_PACKAGE_NAME, OMP_SDK_VERSION, ompNativeMetadata);
  assertPackageIdentity(ompNativePlatformPackage, OMP_SDK_VERSION, ompNativePlatformMetadata);
  assertPackageIdentity(BUN_PACKAGE_NAME, BUN_RUNTIME_VERSION, bunMetadata);
  assertPackageIdentity(bunPlatformPackage, BUN_RUNTIME_VERSION, bunPlatformMetadata);

  const ompPackagePath = path.dirname(ompMetadata.packageJsonPath);
  const ompEntryPath = path.join(ompPackagePath, 'src', 'index.ts');
  if (!fileExists(ompEntryPath)) {
    throw new Error(`Pinned OMP SDK entry source is missing: ${ompEntryPath}`);
  }

  const bunPackagePath = path.dirname(bunMetadata.packageJsonPath);
  const bunExecutable = path.join(bunPackagePath, 'bin', 'bun.exe');
  if (!fileExists(bunExecutable)) {
    throw new Error(`Pinned Bun executable is missing: ${bunExecutable}`);
  }

  let observedBunVersion;
  try {
    observedBunVersion = String(readRuntimeVersion(bunExecutable)).trim();
  } catch (error) {
    throw new Error(`Unable to attest pinned Bun executable: ${error.message}`);
  }
  if (observedBunVersion !== BUN_RUNTIME_VERSION) {
    throw new Error(
      `Bun executable version drift: expected ${BUN_RUNTIME_VERSION}, got ${
        observedBunVersion || 'unknown'
      }`
    );
  }

  const sidecarPath = path.join(packageRoot, SIDECAR_RELATIVE_PATH);
  if (!fileExists(sidecarPath)) {
    throw new Error(`OMP SDK sidecar is missing: ${sidecarPath}`);
  }
  const hostSupervisorPath = path.join(packageRoot, HOST_SUPERVISOR_RELATIVE_PATH);
  if (!fileExists(hostSupervisorPath)) {
    throw new Error(`OMP SDK host supervisor is missing: ${hostSupervisorPath}`);
  }
  let containmentProbe;
  try {
    containmentProbe = JSON.parse(
      String(readContainmentProbe(bunExecutable, hostSupervisorPath)).trim()
    );
  } catch (error) {
    throw new Error(`Unable to attest Linux subreaper/pidfd containment: ${error.message}`);
  }
  if (
    containmentProbe?.protocolVersion !== 1 ||
    containmentProbe?.type !== 'cleanup-attestation' ||
    containmentProbe?.status !== 'clean' ||
    containmentProbe?.mode !== 'linux-subreaper-pidfd' ||
    containmentProbe?.subreaper !== true ||
    containmentProbe?.pidfd !== true ||
    containmentProbe?.ownedProcessCount !== 0
  ) {
    throw new Error('Linux subreaper/pidfd containment probe returned invalid evidence');
  }
  return Object.freeze({
    bunExecutable,
    bunPackagePath,
    bunPlatformPackage,
    bunPlatformPackagePath: path.dirname(bunPlatformMetadata.packageJsonPath),
    bunVersion: BUN_RUNTIME_VERSION,
    ompNativePackagePath: path.dirname(ompNativeMetadata.packageJsonPath),
    ompNativePlatformPackage,
    ompNativePlatformPackagePath: path.dirname(ompNativePlatformMetadata.packageJsonPath),
    ompEntryPath,
    ompVersion: OMP_SDK_VERSION,
    hostSupervisorPath,
    sidecarPath,
  });
}

function packageTarballUrl(packageName, version) {
  const tarballName = packageName.slice(packageName.lastIndexOf('/') + 1);
  return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function assertLockedPackage(
  packageLock,
  packageName,
  identity,
  lockfileName = 'package-lock.json'
) {
  const { version, integrity, optional = false } = identity;
  const locked = packageLock.packages?.[`node_modules/${packageName}`];
  if (!locked) throw new Error(`${lockfileName} is missing ${packageName}`);
  if (locked.version !== version) {
    throw new Error(
      `${lockfileName} ${packageName} version drift: expected ${version}, got ${
        locked.version || 'unknown'
      }`
    );
  }
  if (locked.resolved !== packageTarballUrl(packageName, version)) {
    throw new Error(`${lockfileName} ${packageName} tarball identity drift`);
  }
  if (locked.integrity !== integrity) {
    throw new Error(`${lockfileName} ${packageName} integrity drift`);
  }
  if (optional && locked.optional !== true) {
    throw new Error(`${lockfileName} ${packageName} must remain an optional platform asset`);
  }
  return locked;
}

function publishAllowlistIncludes(files, relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return (files || []).some((entry) => {
    const normalizedEntry = String(entry).replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalizedEntry.endsWith('/')) return normalizedPath.startsWith(normalizedEntry);
    return normalizedEntry === normalizedPath;
  });
}

function assertReleaseIdentity(condition, message) {
  if (!condition) throw new Error(message);
}
function lockfileDigest(lockfile) {
  return crypto.createHash('sha256').update(JSON.stringify(lockfile)).digest('hex');
}
function sourceDigest(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function runtimeClosureDigest(lockfile) {
  const packages = Object.fromEntries(
    Object.entries(lockfile.packages || {})
      .filter(([packagePath, metadata]) => packagePath === '' || metadata.dev !== true)
      .map(([packagePath, metadata]) => {
        if (packagePath !== '') return [packagePath, metadata];
        const runtimeRoot = { ...metadata };
        delete runtimeRoot.devDependencies;
        return [packagePath, runtimeRoot];
      })
  );
  return lockfileDigest({
    lockfileVersion: lockfile.lockfileVersion,
    requires: lockfile.requires,
    packages,
  });
}

function assertRootSpecs(packageJson, lockfile, lockfileName) {
  const root = lockfile.packages?.[''];
  assertReleaseIdentity(root, `${lockfileName} root package metadata is missing`);
  assertReleaseIdentity(
    packageJson.name === root.name,
    `package.json and ${lockfileName} root package names must match`
  );
  assertReleaseIdentity(
    packageJson.version === root.version,
    `package.json and ${lockfileName} root package versions must match`
  );
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    assertReleaseIdentity(
      lockfileDigest(packageJson[field] || {}) === lockfileDigest(root[field] || {}),
      `${lockfileName} root ${field} must exactly match package.json`
    );
  }
  return root;
}

function validatePinnedRuntimeLock(packageJson, lockfile, lockfileName) {
  assertReleaseIdentity(
    lockfile.lockfileVersion === 3,
    `OMP SDK release assets require ${lockfileName} lockfileVersion 3`
  );
  const rootLock = assertRootSpecs(packageJson, lockfile, lockfileName);

  for (const [packageName, version] of [
    [OMP_PACKAGE_NAME, OMP_SDK_VERSION],
    [BUN_PACKAGE_NAME, BUN_RUNTIME_VERSION],
  ]) {
    assertReleaseIdentity(
      packageJson.dependencies?.[packageName] === version,
      `package.json must pin ${packageName} exactly to ${version}`
    );
    assertReleaseIdentity(
      rootLock.dependencies?.[packageName] === version,
      `${lockfileName} root must pin ${packageName} exactly to ${version}`
    );
  }

  const ompLock = assertLockedPackage(
    lockfile,
    OMP_PACKAGE_NAME,
    {
      version: OMP_SDK_VERSION,
      integrity: OMP_SDK_PACKAGE_INTEGRITY,
    },
    lockfileName
  );
  assertReleaseIdentity(
    ompLock.bin?.omp === 'dist/cli.js',
    `${lockfileName} OMP SDK binary metadata drift`
  );
  assertReleaseIdentity(
    ompLock.engines?.bun === '>=1.3.14',
    `${lockfileName} OMP SDK Bun engine metadata drift`
  );

  const nativeLock = assertLockedPackage(
    lockfile,
    OMP_NATIVE_PACKAGE_NAME,
    {
      version: OMP_SDK_VERSION,
      integrity: OMP_NATIVE_PACKAGE_INTEGRITY,
    },
    lockfileName
  );
  assertReleaseIdentity(
    nativeLock.engines?.bun === '>=1.3.14',
    `${lockfileName} OMP native Bun engine metadata drift`
  );
  const expectedNativePlatformNames = Object.values(OMP_NATIVE_PLATFORM_PACKAGES).sort();
  const lockedNativePlatformNames = Object.keys(nativeLock.optionalDependencies || {}).sort();
  assertReleaseIdentity(
    lockfileDigest(expectedNativePlatformNames) === lockfileDigest(lockedNativePlatformNames),
    `${lockfileName} OMP native platform asset set drift`
  );
  for (const packageName of expectedNativePlatformNames) {
    assertReleaseIdentity(
      nativeLock.optionalDependencies[packageName] === OMP_SDK_VERSION,
      `${lockfileName} OMP natives must pin ${packageName} exactly`
    );
    assertLockedPackage(
      lockfile,
      packageName,
      {
        version: OMP_SDK_VERSION,
        integrity: OMP_NATIVE_PLATFORM_ASSET_INTEGRITIES[packageName],
        optional: true,
      },
      lockfileName
    );
  }

  const bunLock = assertLockedPackage(
    lockfile,
    BUN_PACKAGE_NAME,
    {
      version: BUN_RUNTIME_VERSION,
      integrity: BUN_PACKAGE_INTEGRITY,
    },
    lockfileName
  );
  assertReleaseIdentity(
    bunLock.bin?.bun === 'bin/bun.exe',
    `${lockfileName} Bun binary metadata drift`
  );
  assertReleaseIdentity(
    bunLock.bin?.bunx === 'bin/bunx.exe',
    `${lockfileName} Bunx binary metadata drift`
  );

  const expectedBunPlatformNames = Object.keys(BUN_PLATFORM_ASSET_INTEGRITIES).sort();
  const lockedBunPlatformNames = Object.keys(bunLock.optionalDependencies || {}).sort();
  assertReleaseIdentity(
    lockfileDigest(expectedBunPlatformNames) === lockfileDigest(lockedBunPlatformNames),
    `${lockfileName} Bun platform asset set drift`
  );
  for (const packageName of expectedBunPlatformNames) {
    assertReleaseIdentity(
      bunLock.optionalDependencies[packageName] === BUN_RUNTIME_VERSION,
      `${lockfileName} Bun wrapper must pin ${packageName} exactly`
    );
    assertLockedPackage(
      lockfile,
      packageName,
      {
        version: BUN_RUNTIME_VERSION,
        integrity: BUN_PLATFORM_ASSET_INTEGRITIES[packageName],
        optional: true,
      },
      lockfileName
    );
  }
}

function validateOmpSdkReleaseAssets(packageJson, packageLock, options = {}) {
  const packageShrinkwrap = options.packageShrinkwrap;
  assertReleaseIdentity(packageJson, 'OMP SDK release assets require package.json');
  assertReleaseIdentity(packageLock, 'OMP SDK release assets require package-lock.json');
  assertReleaseIdentity(
    packageShrinkwrap,
    'OMP SDK release assets require published npm-shrinkwrap.json'
  );

  validatePinnedRuntimeLock(packageJson, packageLock, 'package-lock.json');
  validatePinnedRuntimeLock(packageJson, packageShrinkwrap, 'npm-shrinkwrap.json');

  assertReleaseIdentity(
    packageJson.ompSdkHostContainment?.supervisor ===
      HOST_SUPERVISOR_RELATIVE_PATH.replaceAll('\\', '/') &&
      packageJson.ompSdkHostContainment?.protocolVersion === 1 &&
      lockfileDigest(packageJson.ompSdkHostContainment?.platforms || []) ===
        lockfileDigest([...HOST_SDK_PLATFORM_KEYS]),
    'package.json OMP SDK host containment identity drift'
  );
  const packageLockRuntimeDigest = runtimeClosureDigest(packageLock);
  const shrinkwrapRuntimeDigest = runtimeClosureDigest(packageShrinkwrap);
  assertReleaseIdentity(
    packageLockRuntimeDigest === shrinkwrapRuntimeDigest,
    'npm-shrinkwrap.json runtime closure identity must exactly match package-lock.json'
  );
  const packageLockIdentityDigest = lockfileDigest(packageLock);
  const shrinkwrapIdentityDigest = lockfileDigest(packageShrinkwrap);
  assertReleaseIdentity(
    packageLockIdentityDigest === shrinkwrapIdentityDigest,
    'npm-shrinkwrap.json digest must exactly match package-lock.json'
  );
  const packageLockDigest = options.packageLockSource
    ? sourceDigest(options.packageLockSource)
    : packageLockIdentityDigest;
  const shrinkwrapDigest = options.packageShrinkwrapSource
    ? sourceDigest(options.packageShrinkwrapSource)
    : shrinkwrapIdentityDigest;
  assertReleaseIdentity(
    packageLockDigest === shrinkwrapDigest,
    'published npm-shrinkwrap.json byte digest must exactly match package-lock.json'
  );
  assertReleaseIdentity(
    publishAllowlistIncludes(packageJson.files, 'npm-shrinkwrap.json'),
    'package.json publish allowlist excludes npm-shrinkwrap.json'
  );

  const supportedPlatformKeys = [...HOST_SDK_PLATFORM_KEYS].sort();
  assertReleaseIdentity(
    supportedPlatformKeys.every(
      (key) =>
        BUN_PLATFORM_PACKAGES[key] !== undefined && OMP_NATIVE_PLATFORM_PACKAGES[key] !== undefined
    ),
    'Host OMP SDK runtime platform set must be covered by pinned Bun and OMP native assets'
  );

  const sourceFiles = options.sourceFiles;
  assertReleaseIdentity(
    Array.isArray(sourceFiles),
    'OMP SDK release source file identities are required'
  );
  for (const sourceFile of REQUIRED_OMP_SDK_SOURCES) {
    assertReleaseIdentity(
      sourceFiles.includes(sourceFile),
      `OMP SDK release source is missing: ${sourceFile}`
    );
    assertReleaseIdentity(
      publishAllowlistIncludes(packageJson.files, sourceFile),
      `package.json publish allowlist excludes ${sourceFile}`
    );
  }

  return Object.freeze({
    bunPlatformPackages: Object.freeze(Object.values(BUN_PLATFORM_PACKAGES).sort()),
    bunVersion: BUN_RUNTIME_VERSION,
    ompNativePlatformPackages: Object.freeze(Object.values(OMP_NATIVE_PLATFORM_PACKAGES).sort()),
    ompVersion: OMP_SDK_VERSION,
    runtimeClosureSha256: packageLockRuntimeDigest,
    shrinkwrapSha256: shrinkwrapDigest,
    sourceFiles: REQUIRED_OMP_SDK_SOURCES,
    supportedPlatforms: Object.freeze(supportedPlatformKeys),
  });
}
module.exports = {
  HOST_SUPERVISOR_RELATIVE_PATH,
  BUN_PACKAGE_NAME,
  BUN_PLATFORM_PACKAGES,
  BUN_RUNTIME_VERSION,
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  OMP_SDK_VERSION,
  REQUIRED_OMP_SDK_SOURCES,
  SIDECAR_RELATIVE_PATH,
  assertPackageIdentity,
  resolveOmpSdkRuntime,
  validateOmpSdkReleaseAssets,
};
