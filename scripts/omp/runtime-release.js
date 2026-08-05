'use strict';

const {
  BUN_PLATFORM_PACKAGES,
  BUN_RUNTIME_VERSION,
  HOST_SDK_PLATFORM_KEYS,
  HOST_SUPERVISOR_RELATIVE_PATH,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_SDK_VERSION,
  REQUIRED_OMP_SDK_SOURCES,
} = require('./runtime-identities');
const {
  assertReleaseIdentity,
  lockfileDigest,
  publishAllowlistIncludes,
  runtimeClosureDigest,
  sourceDigest,
  validatePinnedRuntimeLock,
} = require('./runtime-lock');

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

module.exports = { validateOmpSdkReleaseAssets };
