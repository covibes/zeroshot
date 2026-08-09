'use strict';

const { isDeepStrictEqual } = require('util');

const EXPOSED_PORTS = Object.freeze(['8083/tcp', '8084/tcp', '8085/tcp']);
const REQUIRED_RUNTIME_MODULES = Object.freeze([
  'commandCleanupOwnership',
  'deliveryContract',
  'engineStart',
  'ompConfigOverlay',
  'ompRuntime',
  'ompRuntimeIdentities',
  'ompRuntimeLock',
  'ompRuntimeRelease',
  'runtimeDependencies',
  'worktreeClaudeConfig',
  'worktreeToolingEnv',
]);
const EXPECTED_PACKAGE_MANAGER_PATHS = Object.freeze({
  '/usr/local/bin/npm': false,
  '/usr/local/bin/npx': false,
  '/usr/local/bin/corepack': false,
  '/usr/local/bin/yarn': false,
  '/usr/local/bin/yarnpkg': false,
  '/usr/local/bin/pnpm': false,
  '/usr/local/bin/pnpx': false,
  '/usr/local/lib/node_modules/npm': false,
  '/usr/local/lib/node_modules/corepack': false,
  '/opt/yarn-v1.22.22': false,
});

const RUNTIME_INSPECTION_SCRIPT = `
'use strict';
const fs = require('fs');
const present = (target) => {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const ownership = (target) => {
  const stat = fs.statSync(target);
  return { uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o777).toString(8).padStart(3, '0') };
};
const executable = (target) => (fs.statSync(target).mode & 0o111) !== 0;
const loadable = (target) => {
  try {
    require(target);
    return true;
  } catch {
    return false;
  }
};
const worker = fs.readFileSync('/etc/passwd', 'utf8').split('\\n')
  .find((line) => line.startsWith('zeroshot-worker:')).split(':');
process.stdout.write(JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  worker: { uid: Number(worker[2]), gid: Number(worker[3]) },
  workspace: ownership('/workspace'),
  controlRoot: ownership('/run/zeroshot-capsule-agent'),
  forbiddenPresent: [
    '/usr/bin/gh',
    '/opt/zeroshot/cli',
    '/opt/zeroshot/src/target',
    '/opt/zeroshot/lib/cluster-worker/engine-adapter.js',
  ].filter((target) => fs.existsSync(target)),
  packageManagerPaths: {
    '/usr/local/bin/npm': present('/usr/local/bin/npm'),
    '/usr/local/bin/npx': present('/usr/local/bin/npx'),
    '/usr/local/bin/corepack': present('/usr/local/bin/corepack'),
    '/usr/local/bin/yarn': present('/usr/local/bin/yarn'),
    '/usr/local/bin/yarnpkg': present('/usr/local/bin/yarnpkg'),
    '/usr/local/bin/pnpm': present('/usr/local/bin/pnpm'),
    '/usr/local/bin/pnpx': present('/usr/local/bin/pnpx'),
    '/usr/local/lib/node_modules/npm': present('/usr/local/lib/node_modules/npm'),
    '/usr/local/lib/node_modules/corepack': present('/usr/local/lib/node_modules/corepack'),
    '/opt/yarn-v1.22.22': present('/opt/yarn-v1.22.22'),
  },
  runtimeModules: {
    commandCleanupOwnership: loadable('/opt/zeroshot/src/command-cleanup-ownership.js'),
    deliveryContract: loadable('/opt/zeroshot/lib/delivery-contract.js'),
    engineStart: fs.existsSync('/opt/zeroshot/lib/cluster-worker/engine-start.js'),
    ompConfigOverlay: loadable('/opt/zeroshot/src/omp-config-overlay.js'),
    runtimeDependencies: fs.existsSync('/opt/zeroshot/lib/cluster-worker/runtime-dependencies.js'),
    ompRuntime: loadable('/opt/zeroshot/scripts/omp/runtime.js'),
    ompRuntimeIdentities: loadable('/opt/zeroshot/scripts/omp/runtime-identities.js'),
    ompRuntimeLock: loadable('/opt/zeroshot/scripts/omp/runtime-lock.js'),
    ompRuntimeRelease: loadable('/opt/zeroshot/scripts/omp/runtime-release.js'),
    worktreeClaudeConfig: loadable('/opt/zeroshot/src/worktree-claude-config.js'),
    worktreeToolingEnv: loadable('/opt/zeroshot/src/worktree-tooling-env.js'),
  },
  serverExecutable: executable('/usr/local/bin/zeroshot-oecp-server'),
  tiniExecutable: executable('/usr/bin/tini'),
  gitExecutable: executable('/usr/bin/git'),
  gitAskpassExecutable: executable(
    '/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js'
  ),
  ajvVersion: require('/opt/zeroshot/node_modules/ajv/package.json').version,
  undiciVersion: require(
    '/opt/zeroshot/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json'
  ).version,
}));
`;

function validateImageMetadata(metadata) {
  if (!metadata || metadata.User !== '0:10002') {
    throw new Error('Hosted image supervisor identity is invalid');
  }
  if (
    !isDeepStrictEqual(metadata.Entrypoint, [
      '/usr/bin/tini',
      '-s',
      '--',
      '/usr/local/bin/node',
      '/opt/zeroshot/zeroshot-rust/hosted-node/capsule-entrypoint.js',
    ])
  ) {
    throw new Error('Hosted image does not use the containment subreaper entrypoint');
  }
  if (
    JSON.stringify(Object.keys(metadata.ExposedPorts || {}).sort()) !==
    JSON.stringify(EXPOSED_PORTS)
  ) {
    throw new Error('Hosted image exposes an unexpected port');
  }
  if (
    (metadata.Env || []).some((entry) =>
      /(?:GITHUB|OPENROUTER|CLOUD|INSTALL|CREDENTIAL|TOKEN|SECRET|API_KEY|MODEL)/i.test(entry)
    )
  ) {
    throw new Error('Hosted image contains authority-bearing environment');
  }
}

function validateRuntimeIdentity(runtime) {
  if (runtime.uid !== 0 || runtime.gid !== 10002) {
    throw new Error('Hosted image runtime supervisor identity is invalid');
  }
  if (runtime.worker?.uid !== 10002 || runtime.worker?.gid !== 10002) {
    throw new Error('Hosted image worker identity is invalid');
  }
}

function validateRuntimePermissions(runtime) {
  if (!isDeepStrictEqual(runtime.workspace, { uid: 10002, gid: 10002, mode: '770' })) {
    throw new Error('Hosted image workspace ownership is invalid');
  }
  if (!isDeepStrictEqual(runtime.controlRoot, { uid: 0, gid: 10002, mode: '700' })) {
    throw new Error('Hosted image control directory is not root-owned and private');
  }
}

function validateRequiredRuntimeModules(runtimeModules) {
  if (!REQUIRED_RUNTIME_MODULES.every((name) => runtimeModules?.[name] === true)) {
    throw new Error('Hosted image is missing a required runtime module');
  }
}

function validateRuntimeExecutables(runtime) {
  if (
    runtime.serverExecutable !== true ||
    runtime.tiniExecutable !== true ||
    runtime.gitExecutable !== true ||
    runtime.gitAskpassExecutable !== true ||
    runtime.ajvVersion !== '8.18.0' ||
    runtime.undiciVersion !== '8.9.0'
  ) {
    throw new Error('Hosted image runtime contents are invalid');
  }
}

function validateRuntimeContents(runtime) {
  if (!Array.isArray(runtime.forbiddenPresent) || runtime.forbiddenPresent.length > 0) {
    throw new Error('Hosted image contains a forbidden runtime path');
  }
  if (!isDeepStrictEqual(runtime.packageManagerPaths, EXPECTED_PACKAGE_MANAGER_PATHS)) {
    throw new Error('Hosted image package manager paths are invalid');
  }
  validateRequiredRuntimeModules(runtime.runtimeModules);
  validateRuntimeExecutables(runtime);
}

function validateRuntimeInspection(runtime) {
  if (!runtime) throw new Error('Hosted image runtime inspection is missing');
  validateRuntimeIdentity(runtime);
  validateRuntimePermissions(runtime);
  validateRuntimeContents(runtime);
}

module.exports = {
  RUNTIME_INSPECTION_SCRIPT,
  validateImageMetadata,
  validateRuntimeInspection,
};
