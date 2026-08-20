'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');

const RELEASE_BASE_URL = 'https://github.com/the-open-engine/zeroshot/releases/download';
const RELEASE_TAG_PREFIX = 'zeroshot-rust-v';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const HOST_TARGETS = Object.freeze(
  Object.fromEntries(
    require('../targets.json').map(({ platform, arch, target, executable }) => [
      `${platform}/${arch}`,
      Object.freeze({ target, executable }),
    ])
  )
);

function selectTarget(platform = process.platform, arch = process.arch) {
  const host = `${platform}/${arch}`;
  const selected = HOST_TARGETS[host];
  if (!selected) {
    throw new Error(
      `UNSUPPORTED_ZEROSHOT_RUST_HOST: no prebuilt binary for ${host}; supported hosts: ${Object.keys(HOST_TARGETS).join(', ')}`
    );
  }
  return selected;
}

function archiveName(version, target) {
  return `zeroshot-rust-v${version}-${target}.tar.gz`;
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

function verifyArchive(filename, archive, manifestText) {
  const expected = parseChecksumManifest(manifestText).get(filename);
  if (!expected) throw new Error(`CHECKSUM_MISSING: SHA256SUMS has no entry for ${filename}`);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new Error(`CHECKSUM_MISMATCH: ${filename} expected ${expected} but received ${actual}`);
  }
}

function parseTarSize(header) {
  const value = header.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar entry size');
  return Number.parseInt(value, 8);
}

function extractExecutable(archive, expectedName) {
  let tar;
  try {
    tar = zlib.gunzipSync(archive);
  } catch (error) {
    throw new Error(`ARCHIVE_INVALID: cannot decompress release archive: ${error.message}`);
  }
  let offset = 0;
  let executable = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseTarSize(header.subarray(124, 136));
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error('ARCHIVE_INVALID: truncated tar entry');
    if (name === expectedName) {
      if (executable) throw new Error(`ARCHIVE_INVALID: duplicate ${expectedName}`);
      executable = Buffer.from(tar.subarray(start, end));
    } else {
      throw new Error(`ARCHIVE_INVALID: unexpected archive entry ${name}`);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!executable) throw new Error(`ARCHIVE_INVALID: archive does not contain ${expectedName}`);
  return executable;
}

function download(url, maximumBytes, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'user-agent': '@the-open-engine/zeroshot-rust' } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5)
            return reject(new Error(`DOWNLOAD_FAILED: too many redirects for ${url}`));
          return download(
            new URL(response.headers.location, url).toString(),
            maximumBytes,
            redirects + 1
          ).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`DOWNLOAD_FAILED: ${url} returned HTTP ${response.statusCode}`));
        }
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > maximumBytes)
            request.destroy(new Error(`DOWNLOAD_FAILED: ${url} exceeds ${maximumBytes} bytes`));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    request.on('error', reject);
  });
}

function isReleaseVersion(version) {
  if (typeof version !== 'string') return false;
  const prereleaseStart = version.indexOf('-');
  const core = prereleaseStart === -1 ? version : version.slice(0, prereleaseStart);
  const prerelease = prereleaseStart === -1 ? '' : version.slice(prereleaseStart + 1);
  const coreParts = core.split('.');
  if (coreParts.length !== 3 || coreParts.some((part) => !part || !/^\d+$/.test(part))) {
    return false;
  }
  return (
    !prerelease ||
    prerelease
      .split('.')
      .every(
        (part) =>
          part &&
          [...part].every(
            (character) =>
              (character >= '0' && character <= '9') ||
              (character >= 'A' && character <= 'Z') ||
              (character >= 'a' && character <= 'z') ||
              character === '-'
          )
      )
  );
}

async function install(options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  const metadata =
    options.packageMetadata ||
    JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!isReleaseVersion(metadata.version) || metadata.version === '0.0.0-development') {
    throw new Error(
      `UNRELEASED_SHIM_VERSION: cannot install binary for package version ${metadata.version}`
    );
  }
  const selected = selectTarget(options.platform, options.arch);
  const filename = archiveName(metadata.version, selected.target);
  const baseUrl = `${RELEASE_BASE_URL}/${RELEASE_TAG_PREFIX}${metadata.version}`;
  const fetchBuffer = options.fetchBuffer || download;
  const manifest = await fetchBuffer(`${baseUrl}/SHA256SUMS`, MAX_MANIFEST_BYTES);
  const archive = await fetchBuffer(`${baseUrl}/${filename}`, MAX_ARCHIVE_BYTES);
  verifyArchive(filename, archive, manifest.toString('utf8'));
  const executable = extractExecutable(archive, selected.executable);

  const nativeDirectory = path.join(packageRoot, 'bin', 'native');
  const destination = path.join(nativeDirectory, selected.executable);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.mkdirSync(nativeDirectory, { recursive: true });
  try {
    fs.writeFileSync(temporary, executable, { mode: 0o755, flag: 'wx' });
    fs.renameSync(temporary, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

module.exports = {
  HOST_TARGETS,
  RELEASE_BASE_URL,
  RELEASE_TAG_PREFIX,
  archiveName,
  extractExecutable,
  install,
  parseChecksumManifest,
  selectTarget,
  verifyArchive,
};
