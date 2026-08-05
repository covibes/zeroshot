'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { ROOT, check } = require('./hosted-oecp-manifest');

const DOCKERFILE = path.join(ROOT, 'docker', 'zeroshot-oecp', 'Dockerfile');
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const NAME_PATTERN = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`);
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;
const EXPOSED_PORTS = Object.freeze(['8083/tcp', '8084/tcp', '8085/tcp']);

const isAsciiLetter = (character) =>
  (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');

const isAsciiDigit = (character) => character >= '0' && character <= '9';

const isAlgorithmSeparator = (character) => ['+', '.', '_', '-'].includes(character);

function validDigestAlgorithm(algorithm) {
  if (!isAsciiLetter(algorithm[0])) return false;
  let requiresLetter = false;
  for (const character of algorithm.slice(1)) {
    if (requiresLetter) {
      if (!isAsciiLetter(character)) return false;
      requiresLetter = false;
    } else if (isAlgorithmSeparator(character)) {
      requiresLetter = true;
    } else if (!isAsciiLetter(character) && !isAsciiDigit(character)) {
      return false;
    }
  }
  return !requiresLetter;
}

function validHexDigest(digest) {
  return (
    digest.length >= 32 &&
    [...digest].every(
      (character) =>
        isAsciiDigit(character) ||
        (character >= 'a' && character <= 'f') ||
        (character >= 'A' && character <= 'F')
    )
  );
}

function validDigest(value) {
  const separator = value.indexOf(':');
  return (
    separator > 0 &&
    separator === value.lastIndexOf(':') &&
    validDigestAlgorithm(value.slice(0, separator)) &&
    validHexDigest(value.slice(separator + 1))
  );
}

function validTag(reference) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 512) {
    return false;
  }
  const digestParts = reference.split('@');
  if (digestParts.length > 2 || (digestParts[1] !== undefined && !validDigest(digestParts[1]))) {
    return false;
  }
  let name = digestParts[0];
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  if (lastColon > lastSlash) {
    if (!TAG_PATTERN.test(name.slice(lastColon + 1))) return false;
    name = name.slice(0, lastColon);
  }
  return name.length <= 255 && NAME_PATTERN.test(name);
}

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
    engineStart: fs.existsSync('/opt/zeroshot/lib/cluster-worker/engine-start.js'),
    runtimeDependencies: fs.existsSync('/opt/zeroshot/lib/cluster-worker/runtime-dependencies.js'),
    ompRuntime: loadable('/opt/zeroshot/scripts/omp/runtime.js'),
    ompRuntimeIdentities: loadable('/opt/zeroshot/scripts/omp/runtime-identities.js'),
    ompRuntimeLock: loadable('/opt/zeroshot/scripts/omp/runtime-lock.js'),
    ompRuntimeRelease: loadable('/opt/zeroshot/scripts/omp/runtime-release.js'),
  },
  serverExecutable: executable('/usr/local/bin/zeroshot-oecp-server'),
  tiniExecutable: executable('/usr/bin/tini'),
  gitExecutable: executable('/usr/bin/git'),
  ajvVersion: require('/opt/zeroshot/node_modules/ajv/package.json').version,
  undiciVersion: require(
    '/opt/zeroshot/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json'
  ).version,
}));
`;

function validateImageMetadata(metadata, manifestDigest) {
  if (!metadata || metadata.User !== '0:10002') {
    throw new Error('Hosted image supervisor identity is invalid');
  }
  if (metadata.Labels?.['org.opencontainers.image.revision'] !== manifestDigest) {
    throw new Error('Hosted image OCI revision does not match the current manifest digest');
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

function validateRequiredRuntimeModules(runtimeModules) {
  if (
    runtimeModules?.engineStart !== true ||
    runtimeModules?.runtimeDependencies !== true ||
    runtimeModules?.ompRuntime !== true ||
    runtimeModules?.ompRuntimeIdentities !== true ||
    runtimeModules?.ompRuntimeLock !== true ||
    runtimeModules?.ompRuntimeRelease !== true
  ) {
    throw new Error('Hosted image is missing a required runtime module');
  }
}

function validateRuntimeExecutables(runtime) {
  if (
    runtime.serverExecutable !== true ||
    runtime.tiniExecutable !== true ||
    runtime.gitExecutable !== true ||
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

function run(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with status ${result.status}`);
}

function capture(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} exited with status ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function build(tag) {
  if (!validTag(tag)) throw new Error('Image tag is invalid');
  const digest = check().manifestDigest;
  run('docker', [
    'build',
    '--file',
    DOCKERFILE,
    '--build-arg',
    `BUILD_MANIFEST_DIGEST=${digest}`,
    '--tag',
    tag,
    ROOT,
  ]);
}

function inspect(tag) {
  if (!validTag(tag)) throw new Error('Image tag is invalid');
  const manifestDigest = check().manifestDigest;
  const metadata = JSON.parse(capture('docker', ['image', 'inspect', tag]))[0]?.Config;
  validateImageMetadata(metadata, manifestDigest);
  const runtime = JSON.parse(
    capture('docker', ['run', '--rm', '--entrypoint', 'node', tag, '-e', RUNTIME_INSPECTION_SCRIPT])
  );
  validateRuntimeInspection(runtime);
}

module.exports = {
  ROOT,
  build,
  capture,
  inspect,
  validTag,
  validateImageMetadata,
  validateRuntimeInspection,
};
