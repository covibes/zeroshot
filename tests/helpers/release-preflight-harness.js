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
} = require('../../scripts/release-preflight');
const {
  BUN_RUNTIME_VERSION,
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  OMP_SDK_VERSION,
  resolveOmpSdkContainerRuntime,
  resolveOmpSdkRuntime,
} = require('../../scripts/omp/runtime');

const repositoryRoot = path.join(__dirname, '..', '..');
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

module.exports = {
  BUN_RUNTIME_VERSION,
  OMP_NATIVE_PACKAGE_NAME,
  OMP_NATIVE_PLATFORM_PACKAGES,
  OMP_PACKAGE_NAME,
  OMP_SDK_VERSION,
  REQUIRED_OMP_SDK_SOURCES,
  analyzeMessage,
  assert,
  clone,
  exactPackageJson,
  exactPackageLock,
  exactPackageShrinkwrap,
  exactRuntimeOptions,
  fakePackageRoot,
  maxReleaseType,
  metadataReader,
  releaseTypeForMessages,
  resolveOmpSdkContainerRuntime,
  resolveOmpSdkRuntime,
  runtimeMetadata,
  path,
  validateAssets,
  validateReleaseConfig,
};
