#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const repositoryRoot = path.resolve(__dirname, '..');
const targetManifestPath = path.join(repositoryRoot, 'distribution', 'zeroshot-rust-targets.json');
const targets = Object.freeze(JSON.parse(fs.readFileSync(targetManifestPath, 'utf8')));
const VERSION_ERROR = 'RUST_VERSION_MISMATCH';

function isVersionCharacter(character) {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '-'
  );
}

function normalizeVersion(tag) {
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : tag;
  const prereleaseStart = typeof version === 'string' ? version.indexOf('-') : -1;
  const core = prereleaseStart === -1 ? version : version.slice(0, prereleaseStart);
  const prerelease = prereleaseStart === -1 ? '' : version.slice(prereleaseStart + 1);
  const coreParts = typeof core === 'string' ? core.split('.') : [];
  const validCore = coreParts.length === 3 && coreParts.every((part) => part && /^\d+$/.test(part));
  const validPrerelease =
    !prerelease ||
    prerelease
      .split('.')
      .every((part) => part && [...part].every((character) => isVersionCharacter(character)));
  if (!validCore || !validPrerelease) {
    throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vX.Y.Z`);
  }
  return version;
}

function archiveName(version, target) {
  return `zeroshot-rust-v${normalizeVersion(version)}-${target}.tar.gz`;
}

function targetForHost(platform, arch) {
  const found = targets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch
  );
  if (!found) {
    throw new Error(
      `UNSUPPORTED_ZEROSHOT_RUST_HOST: no prebuilt binary for ${platform}/${arch}; supported hosts: ${targets
        .map((candidate) => `${candidate.platform}/${candidate.arch}`)
        .join(', ')}`
    );
  }
  return found;
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(encoded, offset, length, 'ascii');
}

function tarEntry(name, contents, mode = 0o755) {
  if (Buffer.byteLength(name) > 100) throw new Error(`archive entry name is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(
    header,
    148,
    8,
    [...header].reduce((sum, byte) => sum + byte, 0)
  );
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function createArchive(binary, executable) {
  const tar = Buffer.concat([tarEntry(executable, binary), Buffer.alloc(1024)]);
  return zlib.gzipSync(tar, { level: 9, mtime: 0 });
}

function extractExecutable(archive, expectedName) {
  const tar = zlib.gunzipSync(archive);
  const name = tar.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const sizeText = tar.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
  if (name !== expectedName || !/^[0-7]+$/.test(sizeText)) {
    throw new Error(`ARCHIVE_INVALID: expected sole executable ${expectedName}`);
  }
  const size = Number.parseInt(sizeText, 8);
  const end = 512 + size;
  if (end > tar.length) throw new Error('ARCHIVE_INVALID: truncated executable');
  const nextHeader = 512 + Math.ceil(size / 512) * 512;
  if (!tar.subarray(nextHeader).every((byte) => byte === 0)) {
    throw new Error('ARCHIVE_INVALID: archive contains unexpected entries');
  }
  return Buffer.from(tar.subarray(512, end));
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function parseChecksumManifest(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (checksums.has(match[2])) throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function verifyChecksum(filename, contents, manifest) {
  const checksums = manifest instanceof Map ? manifest : parseChecksumManifest(manifest);
  const expected = checksums.get(filename);
  if (!expected) throw new Error(`CHECKSUM_MISSING: SHA256SUMS has no entry for ${filename}`);
  const actual = sha256(contents);
  if (actual !== expected) {
    throw new Error(`CHECKSUM_MISMATCH: ${filename} expected ${expected} but received ${actual}`);
  }
  return true;
}

function packageTarget({ target, version, binaryPath, outputDirectory }) {
  const declaration = targets.find((candidate) => candidate.target === target);
  if (!declaration) throw new Error(`undeclared Rust release target: ${target}`);
  const binary = fs.readFileSync(binaryPath);
  const filename = archiveName(version, target);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, filename),
    createArchive(binary, declaration.executable)
  );
  return filename;
}

function createManifest({ version, directory }) {
  const entries = targets.map(({ target }) => {
    const filename = archiveName(version, target);
    const contents = fs.readFileSync(path.join(directory, filename));
    return `${sha256(contents)}  ${filename}`;
  });
  const manifest = `${entries.join('\n')}\n`;
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), manifest);
  const parsed = parseChecksumManifest(manifest);
  for (const { target } of targets) {
    const filename = archiveName(version, target);
    verifyChecksum(filename, fs.readFileSync(path.join(directory, filename)), parsed);
  }
  return manifest;
}

function cargoVersion(cargoToml) {
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const version = packageSection && packageSection[1].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!version) throw new Error('zeroshot-rust/Cargo.toml has no package version');
  return version[1];
}

function checkVersionCoupling(
  tag,
  cargoToml = fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8')
) {
  const releaseVersion = normalizeVersion(tag);
  const manifestVersion = cargoVersion(cargoToml);
  if (releaseVersion !== manifestVersion) {
    throw new Error(
      `${VERSION_ERROR}: release tag version ${releaseVersion} does not match zeroshot-rust/Cargo.toml version ${manifestVersion}`
    );
  }
  return releaseVersion;
}

function checkRepository(
  workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
    'utf8'
  )
) {
  const declared = targets.map(({ target }) => target).sort();
  const matrixTargets = [...workflow.matchAll(/^\s+- target:\s*([^\s]+)\s*$/gm)]
    .map((match) => match[1])
    .sort();
  assertSameList('Rust release workflow matrix', declared, matrixTargets);

  for (const required of [
    'cargo build --release --locked -p zeroshot-rust --bin zeroshot-rust --target',
    'node scripts/rust-distribution.js check-version',
    'node scripts/rust-distribution.js package',
    'node scripts/rust-distribution.js smoke-archive',
    'actions/upload-artifact@',
    'node scripts/rust-distribution.js manifest',
    'SHA256SUMS',
  ]) {
    if (!workflow.includes(required)) {
      throw new Error(`RUST_DISTRIBUTION_INTEGRITY: release workflow is missing ${required}`);
    }
  }
  const couplingCheck = workflow.indexOf('node scripts/rust-distribution.js check-version');
  const publication = workflow.indexOf('      - name: Run semantic-release\n');
  if (couplingCheck === -1 || publication === -1 || couplingCheck > publication) {
    throw new Error(
      'RUST_DISTRIBUTION_INTEGRITY: Rust version coupling must run before semantic-release'
    );
  }
  return true;
}

function assertSameList(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `${label} differs from declared targets: expected ${expected.join(', ')}; got ${actual.join(', ')}`
    );
  }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing --${name}`);
  return process.argv[index + 1];
}

function run() {
  const command = process.argv[2];
  if (command === 'package') {
    const filename = packageTarget({
      target: argument('target'),
      version: argument('version'),
      binaryPath: argument('binary'),
      outputDirectory: argument('out'),
    });
    process.stdout.write(`${filename}\n`);
    return;
  }
  if (command === 'manifest') {
    createManifest({ version: argument('version'), directory: argument('dir') });
    process.stdout.write(`verified ${targets.length} archives and SHA256SUMS\n`);
    return;
  }
  if (command === 'dry-run') {
    const version = argument('version');
    const binaryPath = argument('binary');
    const outputDirectory = argument('out');
    for (const { target } of targets)
      packageTarget({ target, version, binaryPath, outputDirectory });
    createManifest({ version, directory: outputDirectory });
    process.stdout.write(`dry-run produced and verified ${targets.length} archives\n`);
    return;
  }
  if (command === 'check-version') {
    const version = checkVersionCoupling(argument('tag'));
    process.stdout.write(`Rust package version matches release tag: ${version}\n`);
    return;
  }
  if (command === 'print-version') {
    process.stdout.write(
      `${cargoVersion(fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8'))}\n`
    );
    return;
  }
  if (command === 'smoke') {
    const binaryPath = path.resolve(argument('binary'));
    const result = childProcess.spawnSync(binaryPath, [], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) {
      throw new Error(
        `RUST_BINARY_SMOKE_FAILED: status=${result.status} signal=${result.signal || 'none'}`
      );
    }
    process.stdout.write(`Rust release executable exited 0: ${binaryPath}\n`);
    return;
  }
  if (command === 'smoke-archive') {
    const target = argument('target');
    const declaration = targets.find((candidate) => candidate.target === target);
    if (!declaration) throw new Error(`undeclared Rust release target: ${target}`);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-rust-smoke-'));
    const binaryPath = path.join(directory, declaration.executable);
    try {
      const executable = extractExecutable(
        fs.readFileSync(argument('archive')),
        declaration.executable
      );
      fs.writeFileSync(binaryPath, executable, { mode: 0o755 });
      const result = childProcess.spawnSync(binaryPath, [], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.signal || result.status !== 0) {
        throw new Error(
          `RUST_ARCHIVE_SMOKE_FAILED: status=${result.status} signal=${result.signal || 'none'}`
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(`Rust release archive executable exited 0: ${target}\n`);
    return;
  }
  if (command === 'check-repository') {
    checkRepository();
    process.stdout.write(
      `Rust distribution workflow declares ${targets.length} complete targets\n`
    );
    return;
  }
  throw new Error(
    'usage: rust-distribution.js <package|manifest|dry-run|check-version|check-repository|print-version|smoke|smoke-archive>'
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  VERSION_ERROR,
  archiveName,
  checkRepository,
  checkVersionCoupling,
  createArchive,
  createManifest,
  extractExecutable,
  cargoVersion,
  normalizeVersion,
  packageTarget,
  parseChecksumManifest,
  sha256,
  targetForHost,
  targets,
  verifyChecksum,
};
