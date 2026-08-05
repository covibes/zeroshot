'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  RUNTIME_INSPECTION_SCRIPT,
  validateImageMetadata,
  validateRuntimeInspection,
} = require('./hosted-oecp-image-inspection');
const { ROOT, check } = require('./hosted-oecp-manifest');

const DOCKERFILE = path.join(ROOT, 'docker', 'zeroshot-oecp', 'Dockerfile');
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const NAME_PATTERN = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`);
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;

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

function run(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with status ${result.status}`);
}

function capture(program, args) {
  const result = spawnSync(program, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
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
