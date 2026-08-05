#!/usr/bin/env node
'use strict';

const { ok: invariant } = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exerciseImage, REPOSITORY } = require('./hosted-oecp-certification-runtime');
const { build, capture, inspect, validTag } = require('./hosted-oecp-image-commands');
const { check } = require('./hosted-oecp-manifest');
const { PRIVATE_MARKER } = require('../private/hosted-cli-candidate/manifest');

function parseArgs(argv) {
  const options = { imageTag: 'zeroshot-oecp:certification' };
  let valueFor;
  const names = {
    '--image-tag': 'imageTag',
    '--zero-cloud-commit': 'zeroCloudCommit',
  };
  for (const argument of argv) {
    if (valueFor !== undefined) {
      options[valueFor] = argument;
      valueFor = undefined;
    } else if (names[argument]) {
      valueFor = names[argument];
    } else {
      throw new Error(`unknown certification argument ${argument}`);
    }
  }
  if (valueFor !== undefined) throw new Error('certification argument value is missing');
  if (!/^[a-f0-9]{40}$/.test(options.zeroCloudCommit || '')) {
    throw new Error('--zero-cloud-commit <40 lowercase hex> is required');
  }
  if (!validTag(options.imageTag)) throw new Error('--image-tag is invalid');
  return Object.freeze(options);
}

function stablePackagePaths(packDocument) {
  const files = packDocument?.files;
  invariant(Array.isArray(files) && files.length > 0, 'Stable npm pack returned no files');
  return files.map((file) => file.path);
}

function assertStablePackageIsolation(packDocument) {
  const paths = stablePackagePaths(packDocument);
  const forbidden = paths.filter(
    (file) =>
      file.startsWith('private/') ||
      file.startsWith('tests/private-hosted-cli/') ||
      file.startsWith('docker/zeroshot-oecp/') ||
      file.startsWith('scripts/hosted-oecp-') ||
      file === 'PRIVATE_HOSTED_CANDIDATE.txt'
  );
  invariant(forbidden.length === 0, `Stable npm package leaked private paths: ${forbidden}`);
  invariant(
    !JSON.stringify(packDocument).includes(PRIVATE_MARKER),
    'Stable npm package leaked the private candidate marker'
  );
}

function assertCertificationProvenance(candidate, packageManifest, expected) {
  for (const [field, value] of Object.entries(expected)) {
    invariant(candidate[field] === value, `Candidate provenance ${field} does not match the image`);
    invariant(
      packageManifest.zeroshotPrivateCandidate?.[field] === value,
      `Packed candidate ${field} does not match its provenance`
    );
  }
  invariant(
    packageManifest.name === '@the-open-engine/zeroshot-private-hosted-candidate' &&
      packageManifest.private === true,
    'Candidate package identity is invalid'
  );
  invariant(
    /^sha256:[a-f0-9]{64}$/.test(candidate.tarballDigest || ''),
    'Candidate tarball digest is invalid'
  );
}

function buildGeneratedRuntime() {
  for (const script of ['build:agent-cli-provider', 'build:cluster', 'build:target']) {
    capture('npm', ['run', script]);
  }
}

function stablePackageCheck() {
  const packed = JSON.parse(
    capture('npm', [
      'pack',
      '--json',
      '--dry-run',
      '--ignore-scripts',
      '--foreground-scripts=false',
    ])
  )[0];
  assertStablePackageIsolation(packed);
}

function imageDigest(tag) {
  const digest = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  invariant(/^sha256:[a-f0-9]{64}$/.test(digest), 'Built image digest is invalid');
  return digest;
}

function imageManifestDigest(tag) {
  return capture('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    tag,
  ]);
}

function buildCandidate(expected, temporaryRoot) {
  const output = path.join(temporaryRoot, 'candidate');
  const document = JSON.parse(
    capture(process.execPath, [
      'private/hosted-cli-candidate/build-candidate.js',
      '--runtime-image-digest',
      expected.runtimeImageDigest,
      '--runtime-manifest-digest',
      expected.runtimeManifestDigest,
      '--zero-cloud-commit',
      expected.zeroCloudCommit,
      '--repository',
      REPOSITORY,
      '--provider',
      'codex',
      '--model-level',
      'level2',
      '--out',
      output,
    ])
  );
  const provenance = JSON.parse(fs.readFileSync(document.provenancePath, 'utf8'));
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(document.stage, 'package.json'), 'utf8')
  );
  assertCertificationProvenance(provenance, packageManifest, expected);
  invariant(fs.existsSync(document.tarballPath), 'Candidate tarball is missing');
  return provenance;
}

async function certify(options) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-certification-'));
  try {
    buildGeneratedRuntime();
    const manifest = check();
    build(options.imageTag);
    inspect(options.imageTag);
    const runtimeImageDigest = imageDigest(options.imageTag);
    const runtimeManifestDigest = imageManifestDigest(options.imageTag);
    invariant(
      runtimeManifestDigest === manifest.manifestDigest,
      'Built image label does not match the checked runtime manifest'
    );
    stablePackageCheck();
    const sourceSha = capture('git', ['rev-parse', 'HEAD']);
    const expected = {
      sourceSha,
      zeroCloudCommit: options.zeroCloudCommit,
      runtimeImageDigest,
      runtimeManifestDigest,
    };
    const candidate = buildCandidate(expected, temporaryRoot);
    check();
    inspect(options.imageTag);
    await exerciseImage(options.imageTag);
    return {
      candidateTarballDigest: candidate.tarballDigest,
      runtimeImageDigest,
      runtimeManifestDigest,
      sourceSha,
      zeroCloudCommit: options.zeroCloudCommit,
      scenarios: ['websocket-failure', 'runintent-success', 'runintent-failure', 'shutdown'],
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const evidence = await certify(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertCertificationProvenance,
  assertStablePackageIsolation,
  parseArgs,
};
