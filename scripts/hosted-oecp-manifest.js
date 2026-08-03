'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docker', 'zeroshot-oecp', 'build-manifest.json');
const INPUTS = Object.freeze([
  'Cargo.lock',
  'Cargo.toml',
  'clippy.toml',
  'crates',
  'docker/zeroshot-oecp/.dockerignore',
  'docker/zeroshot-oecp/Dockerfile',
  'docker/zeroshot-oecp/Dockerfile.dockerignore',
  'docker/zeroshot-oecp/package-lock.json',
  'docker/zeroshot-oecp/package.json',
  'lib/cluster-worker/contracts.js',
  'lib/cluster-worker/engine-adapter-common.js',
  'lib/cluster-worker/engine-start.js',
  'lib/cluster-worker/executable.js',
  'lib/cluster-worker/index.js',
  'lib/cluster-worker/object-utils.js',
  'lib/cluster-worker/profiles.js',
  'lib/cluster-worker/runtime-dependencies.js',
  'lib/cluster-worker/runtime-engine.js',
  'lib/cluster-worker/runtime-support.js',
  'lib/cluster-worker/state-machine.js',
  'lib/cluster-worker/terminal-normalizer.js',
  'lib/cluster-worker/worker-internals.js',
  'lib/run-plan.js',
  'package-lock.json',
  'package.json',
  'scripts/hosted-oecp-image-commands.js',
  'scripts/hosted-oecp-image-smoke.js',
  'scripts/hosted-oecp-image.js',
  'scripts/hosted-oecp-manifest.js',
  'scripts/hosted-oecp-smoke-capability.js',
  'scripts/hosted-oecp-smoke-client.js',
  'scripts/hosted-oecp-smoke-fixture.js',
  'protocol/openengine-cluster/v1/worker.schema.json',
  'rust-toolchain.toml',
  'zeroshot-rust/Cargo.toml',
  'zeroshot-rust/hosted-node',
  'zeroshot-rust/src',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function directoryEntries(root, relative = '', include = () => true) {
  const entries = {};
  const directory = path.join(root, relative);
  for (const name of fs.readdirSync(directory).sort()) {
    const childRelative = relative ? path.join(relative, name) : name;
    const normalized = childRelative.split(path.sep).join('/');
    if (!include(normalized)) continue;
    const child = path.join(root, childRelative);
    const metadata = fs.lstatSync(child);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Manifest input contains a symbolic link: ${childRelative}`);
    }
    if (metadata.isDirectory()) {
      Object.assign(entries, directoryEntries(root, childRelative, include));
    } else if (metadata.isFile()) {
      entries[normalized] = sha256(fs.readFileSync(child));
    } else {
      throw new Error(`Manifest input is not a regular file or directory: ${childRelative}`);
    }
  }
  return entries;
}

function includeManifestInput(input, child) {
  if (input !== 'zeroshot-rust/src' || !child.startsWith('hosted_oecp/')) return true;
  return !child.endsWith('_tests.rs') && child !== 'hosted_oecp/test_support.rs';
}

function digestInput(relative) {
  const absolute = path.join(ROOT, relative);
  const metadata = fs.lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`Manifest input is a symbolic link: ${relative}`);
  if (metadata.isFile()) return sha256(fs.readFileSync(absolute));
  if (metadata.isDirectory()) {
    return sha256(
      canonical(directoryEntries(absolute, '', (child) => includeManifestInput(relative, child)))
    );
  }
  throw new Error(`Manifest input is not a regular file or directory: ${relative}`);
}

function parseBaseImage(line) {
  const tokens = line.trim().split(/\s+/u);
  if (tokens[0]?.toUpperCase() !== 'FROM') return null;
  if (tokens.length !== 2 && tokens.length !== 4) {
    throw new Error(`Hosted OECP Dockerfile has malformed FROM instruction: ${line}`);
  }
  if (tokens.length === 4 && tokens[2].toUpperCase() !== 'AS') {
    throw new Error(`Hosted OECP Dockerfile has malformed FROM instruction: ${line}`);
  }
  return { reference: tokens[1], stage: tokens[3] || 'runtime' };
}

function isLowerHex(character) {
  return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
}

function immutableImageReference(reference) {
  const separator = reference.lastIndexOf('@sha256:');
  if (separator <= 0) return false;
  const digest = reference.slice(separator + '@sha256:'.length);
  return digest.length === 64 && [...digest].every(isLowerHex);
}

function immutableBaseImages(
  dockerfile = fs.readFileSync(path.join(ROOT, 'docker', 'zeroshot-oecp', 'Dockerfile'), 'utf8')
) {
  const images = [];
  for (const line of dockerfile.split('\n')) {
    const image = parseBaseImage(line);
    if (!image) continue;
    if (!immutableImageReference(image.reference)) {
      throw new Error(`Hosted OECP base image is not immutable: ${image.reference}`);
    }
    images.push(image);
  }
  if (images.length === 0 || images.at(-1).stage !== 'runtime') {
    throw new Error('Hosted OECP Dockerfile has no final runtime image');
  }
  return images;
}

function validateContextAllowlist(checked, active) {
  const dockerDirectory = path.join(ROOT, 'docker', 'zeroshot-oecp');
  const checkedAllowlist =
    checked ?? fs.readFileSync(path.join(dockerDirectory, '.dockerignore'), 'utf8');
  const activeAllowlist =
    active ?? fs.readFileSync(path.join(dockerDirectory, 'Dockerfile.dockerignore'), 'utf8');
  if (checkedAllowlist !== activeAllowlist || !activeAllowlist.startsWith('**\n')) {
    throw new Error('Hosted OECP Docker context allowlist drifted or is not deny-all');
  }
}

function createManifest() {
  validateContextAllowlist();
  const inputs = Object.fromEntries(INPUTS.map((relative) => [relative, digestInput(relative)]));
  const imageInputsDigest = sha256(canonical(inputs));
  const document = {
    schemaVersion: 2,
    artifact: { name: 'zeroshot-oecp', private: true, published: false },
    protocol: {
      version: 'openengine.cluster/v1',
      route: '/oecp',
      graphProfiles: ['openengine.graph.single-worker/v1'],
      workerProfiles: ['legacy.zeroshot.ship@1'],
    },
    runtime: {
      supervisor: { user: 'root', uid: 0, gid: 0 },
      worker: { user: 'zeroshot-worker', uid: 10002, gid: 10002 },
      capabilityFile: '/run/zeroshot-capsule-agent/capability',
      port: 8080,
      workspace: '/workspace',
      legacyLimitation: 'bounded Node worker; not native-v2 or openengine.graph.full/v1 certified',
    },
    image: {
      baseImages: immutableBaseImages(),
      init: { path: '/usr/bin/tini', version: '0.19.0', sourceStage: 'tini' },
    },
    inputs,
    imageInputsDigest,
    rollback: {
      policy: 'remove-or-restore-private-digest',
      stableReleasesUntouched: true,
    },
  };
  return { ...document, manifestDigest: sha256(canonical(document)) };
}

function encodedManifest(manifest = createManifest()) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function check() {
  const manifest = createManifest();
  const actual = fs.readFileSync(MANIFEST, 'utf8');
  if (actual !== encodedManifest(manifest)) {
    throw new Error('Hosted OECP build manifest drifted; run write mode');
  }
  process.stdout.write(`${manifest.manifestDigest}\n`);
  return manifest;
}

function write() {
  const manifest = createManifest();
  fs.writeFileSync(MANIFEST, encodedManifest(manifest));
  process.stdout.write(`${manifest.manifestDigest}\n`);
  return manifest;
}

module.exports = {
  ROOT,
  check,
  createManifest,
  immutableBaseImages,
  validateContextAllowlist,
  write,
};
