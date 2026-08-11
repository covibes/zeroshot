/**
 * Fixtures for OMP session partitions and the shared OMP CAS blob store, shaped exactly like the
 * tagged v17.2.1 layout so verification tests exercise the real contract rather than an invented
 * one:
 *
 *   <storageRoot>/omp-sessions/<uuid>/<fileSafeTimestamp>_<sessionId>.jsonl   session transcript
 *   <storageRoot>/omp-sessions/<uuid>/<fileSafeTimestamp>_<sessionId>/        sibling artifacts dir
 *   <blobRoot>/blobs/<sha256-hex>                                            shared CAS blob
 *
 * Blob references are *nested strings* inside JSONL records (`blob:sha256:<hex>`), never
 * pointer-only files: packages/coding-agent/src/session/blob-store.ts externalizes payloads to the
 * shared store and leaves the reference in place inside the record.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  allocateOmpSessionPartition,
  generateOmpPartitionId,
  partitionPathFor,
  createOmpSessionPartitionDirectory,
} = require('../../src/omp-session-partition');

const SESSION_TIMESTAMP = '2026-08-02T00:00:00.000Z';

function sessionFileNameFor(sessionId) {
  return `${SESSION_TIMESTAMP.replace(/[:.]/g, '-')}_${sessionId}.jsonl`;
}

function makeStorageRoot(prefix = 'zeroshot-omp-storage-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a shared OMP blob store. Returns `{blobRoot, blobsDir, put, env}` where `env` is the
 * environment overlay that makes src/omp-blob-root.ts resolve to it (the same
 * `PI_CODING_AGENT_DIR` override OMP itself honours).
 */
function makeBlobStore(prefix = 'zeroshot-omp-blobs-') {
  const blobRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const blobsDir = path.join(blobRoot, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  return {
    blobRoot,
    blobsDir,
    env: { PI_CODING_AGENT_DIR: blobRoot },
    /** Write bytes to the store and return their canonical `blob:sha256:<hex>` reference. */
    put(data, { extension } = {}) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const hex = crypto.createHash('sha256').update(buffer).digest('hex');
      fs.writeFileSync(path.join(blobsDir, hex), buffer);
      if (extension) {
        // blob-store.ts hardlinks a typed sidecar for OS image openers, so the canonical blob
        // legitimately carries nlink > 1. Verification must accept that.
        fs.linkSync(path.join(blobsDir, hex), path.join(blobsDir, `${hex}.${extension}`));
      }
      return `blob:sha256:${hex}`;
    },
    /** Snapshot of every entry in the store, for "cleanup left the blob root untouched" asserts. */
    snapshot() {
      return fs
        .readdirSync(blobsDir)
        .sort()
        .map((name) => `${name}:${fs.readFileSync(path.join(blobsDir, name)).toString('hex')}`);
    },
  };
}

/**
 * Create a materialized session partition.
 *
 * @param {object} options
 * @param {string} options.storageRoot
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd] value recorded in the session header
 * @param {unknown[]} [options.records] records appended after the header
 * @param {string[]} [options.artifacts] relative paths under the sibling artifacts dir
 * @param {string} [options.partitionId] reuse a pre-allocated partition id
 */
function makeSessionPartition({
  storageRoot,
  sessionId = `sess-${crypto.randomUUID().slice(0, 8)}`,
  cwd = storageRoot,
  records = [],
  artifacts = [],
  partitionId,
} = {}) {
  const id = partitionId || generateOmpPartitionId();
  const partitionPath = partitionPathFor(storageRoot, id);
  createOmpSessionPartitionDirectory(partitionPath);

  const sessionFileName = sessionFileNameFor(sessionId);
  const sessionFilePath = path.join(partitionPath, sessionFileName);
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: SESSION_TIMESTAMP,
      cwd,
    }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  fs.writeFileSync(sessionFilePath, `${lines.join('\n')}\n`);

  const artifactsDir = sessionFilePath.slice(0, -'.jsonl'.length);
  for (const relative of artifacts) {
    const target = path.join(artifactsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `artifact:${relative}\n`);
  }

  return {
    partitionId: id,
    partitionPath,
    sessionId,
    sessionFileName,
    sessionFilePath,
    artifactsDir,
    identity() {
      const stat = fs.statSync(partitionPath);
      return { device: String(stat.dev), inode: String(stat.ino) };
    },
    sessionFileIdentity() {
      const stat = fs.statSync(sessionFilePath);
      return { device: String(stat.dev), inode: String(stat.ino) };
    },
  };
}

/** Run `body` with `env` applied to process.env, restoring the previous values afterwards. */
function withEnv(env, body) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

module.exports = {
  SESSION_TIMESTAMP,
  allocateOmpSessionPartition,
  makeBlobStore,
  makeSessionPartition,
  makeStorageRoot,
  sessionFileNameFor,
  withEnv,
};
