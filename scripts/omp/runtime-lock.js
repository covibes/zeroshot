'use strict';

const crypto = require('crypto');
const {
  BUN_PACKAGE_INTEGRITY,
  BUN_PACKAGE_NAME,
  BUN_PLATFORM_ASSET_INTEGRITIES,
  BUN_RUNTIME_VERSION,
  OMP_NATIVE_PACKAGE_INTEGRITY,
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_ASSET_INTEGRITIES,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  OMP_SDK_PACKAGE_INTEGRITY,
  OMP_SDK_VERSION,
} = require('./runtime-identities');

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

module.exports = {
  assertReleaseIdentity,
  lockfileDigest,
  publishAllowlistIncludes,
  runtimeClosureDigest,
  sourceDigest,
  validatePinnedRuntimeLock,
};
