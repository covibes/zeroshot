'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, check } = require('./hosted-oecp-manifest');

const DOCKERFILE = path.join(ROOT, 'docker', 'zeroshot-oecp', 'Dockerfile');
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const NAME_PATTERN = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`);
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;

function isAsciiLetter(character) {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

function isAsciiDigit(character) {
  return character >= '0' && character <= '9';
}

function isAlgorithmSeparator(character) {
  return ['+', '.', '_', '-'].includes(character);
}

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
const ownership = (target) => {
  const stat = fs.statSync(target);
  return { uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o777).toString(8).padStart(3, '0') };
};
const executable = (target) => (fs.statSync(target).mode & 0o111) !== 0;
const worker = fs.readFileSync('/etc/passwd', 'utf8').split('\\n')
  .find((line) => line.startsWith('zeroshot-worker:')).split(':');
process.stdout.write(JSON.stringify({
  uid: process.getuid(),
  worker: { uid: Number(worker[2]), gid: Number(worker[3]) },
  workspace: ownership('/workspace'),
  controlRoot: ownership('/run/zeroshot-capsule-agent'),
  forbiddenPresent: [
    '/usr/bin/gh',
    '/opt/zeroshot/cli',
    '/opt/zeroshot/src/target',
    '/opt/zeroshot/lib/cluster-worker/engine-adapter.js',
  ].filter((target) => fs.existsSync(target)),
  runtimeModules: {
    engineStart: fs.existsSync('/opt/zeroshot/lib/cluster-worker/engine-start.js'),
    runtimeDependencies: fs.existsSync('/opt/zeroshot/lib/cluster-worker/runtime-dependencies.js'),
  },
  serverExecutable: executable('/usr/local/bin/zeroshot-oecp-server'),
  tiniExecutable: executable('/usr/bin/tini'),
  gitExecutable: executable('/usr/bin/git'),
  ajvVersion: require('/opt/zeroshot/node_modules/ajv/package.json').version,
}));
`;

function validateImageMetadata(metadata, manifestDigest) {
  if (!metadata || metadata.User !== '0:0') {
    throw new Error('Hosted image supervisor is not root');
  }
  if (metadata.Labels?.['org.opencontainers.image.revision'] !== manifestDigest) {
    throw new Error('Hosted image OCI revision does not match the current manifest digest');
  }
  if (
    JSON.stringify(metadata.Entrypoint) !==
    JSON.stringify([
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
    JSON.stringify(Object.keys(metadata.ExposedPorts || {}).sort()) !== JSON.stringify(['8080/tcp'])
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
  if (runtime.uid !== 0) throw new Error('Hosted image runtime supervisor is not root');
  if (runtime.worker?.uid !== 10002 || runtime.worker?.gid !== 10002) {
    throw new Error('Hosted image worker identity is invalid');
  }
}

function validateRuntimePermissions(runtime) {
  if (
    JSON.stringify(runtime.workspace) !== JSON.stringify({ uid: 10002, gid: 10002, mode: '770' })
  ) {
    throw new Error('Hosted image workspace ownership is invalid');
  }
  if (
    JSON.stringify(runtime.controlRoot) !== JSON.stringify({ uid: 1000, gid: 10002, mode: '700' })
  ) {
    throw new Error('Hosted image control directory is not capsule-agent-only');
  }
}

function validateRuntimeContents(runtime) {
  if (!Array.isArray(runtime.forbiddenPresent) || runtime.forbiddenPresent.length > 0) {
    throw new Error('Hosted image contains a forbidden runtime path');
  }
  if (
    runtime.runtimeModules?.engineStart !== true ||
    runtime.runtimeModules?.runtimeDependencies !== true
  ) {
    throw new Error('Hosted image is missing a required runtime module');
  }
  if (
    runtime.serverExecutable !== true ||
    runtime.tiniExecutable !== true ||
    runtime.gitExecutable !== true ||
    runtime.ajvVersion !== '8.18.0'
  ) {
    throw new Error('Hosted image runtime contents are invalid');
  }
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
