const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { isInsideOmpBlobsDir } = require('./omp-blob-root');

// Every OMP session partition lives under <storageRoot>/omp-sessions/<uuid>/. storageRoot is the
// owning cluster's storageDir for cluster-agent tasks or the standalone TASKS_DIR otherwise (see
// task-lib/omp-storage-root.js) — never derived from prompt text or cwd. The shared OMP CAS blob
// store is *not* under here at all (it is machine-wide, at pi-utils::getBlobsDir(); see
// src/omp-blob-root.js), which is what makes per-task partition deletion safe.
const OMP_SESSIONS_SUBDIR = 'omp-sessions';
const PARTITION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DELETING_PREFIX = '.zeroshot-deleting-';

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
// See src/omp-session-verifier.js: O_NONBLOCK stops a FIFO planted at one of these paths from
// blocking the open forever; the fstat that follows still rejects the wrong type.
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

function ompSessionsRoot(storageRoot) {
  return path.join(path.resolve(storageRoot), OMP_SESSIONS_SUBDIR);
}

function partitionPathFor(storageRoot, partitionId) {
  if (typeof partitionId !== 'string' || !PARTITION_ID_PATTERN.test(partitionId)) {
    throw new Error(`Invalid OMP session partition id: ${partitionId}`);
  }
  return path.join(ompSessionsRoot(storageRoot), partitionId);
}

function generateOmpPartitionId() {
  return randomUUID();
}

/** Owner-only (0700) directory creation. Idempotent: safe to call once the row referencing this
 * partitionId is already durable (row-before-directory — see task-lib/runner.js). */
function createOmpSessionPartitionDirectory(partitionPath) {
  fs.mkdirSync(partitionPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(partitionPath, 0o700);
  }
}

/**
 * Allocate a fresh, random, secret-free UUID partition directory under storageRoot in one step.
 * Callers that must durably record the partitionId before the directory exists on disk (fresh
 * task spawn — see task-lib/runner.js) should use generateOmpPartitionId/partitionPathFor and
 * createOmpSessionPartitionDirectory separately instead, in that order.
 */
function allocateOmpSessionPartition(storageRoot) {
  const partitionId = generateOmpPartitionId();
  const partitionPath = partitionPathFor(storageRoot, partitionId);
  createOmpSessionPartitionDirectory(partitionPath);
  return { partitionId, path: partitionPath };
}

function identityOf(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(a, b) {
  return Boolean(a) && Boolean(b) && a.device === b.device && a.inode === b.inode;
}

/** Descriptor-pinned directory identity: never follows a final symlink, and the returned identity
 * describes the descriptor itself rather than a second pathname lookup. */
function pinDirectoryIdentity(dirPath) {
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) {
      throw Object.assign(new Error(`${dirPath} is not a directory`), { code: 'ENOTDIR' });
    }
    return { identity: identityOf(stat), uid: stat.uid };
  } finally {
    fs.closeSync(fd);
  }
}

function currentUid() {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '0';
}

/**
 * Delete one owner-validated partition directory. Never the shared OMP CAS blob root, never
 * anything outside `<storageRoot>/omp-sessions/`, and never a directory that is not the one the
 * persisted ownership record describes.
 *
 * The check/use race (CodeQL js/file-system-race) is closed by *moving before deleting*: the
 * partition is renamed, within its own parent, to an unguessable `.zeroshot-deleting-<uuid>` name
 * and only then re-pinned and removed. `rename(2)` is atomic, so after it succeeds the object
 * under that fresh name can no longer be swapped by racing the original path; the post-rename
 * identity comparison proves it is still the same directory that passed validation, and any
 * mismatch aborts with the directory parked under its clearly-marked name rather than recursively
 * deleting an unknown tree.
 *
 * Never throws. `{deleted:false, reason}` means the caller must preserve the owner record and warn.
 *
 * @param {object} ownership canonical, already-validated task.ompSessionOwnership record
 */
function deleteOmpSessionPartition(ownership) {
  if (!ownership || typeof ownership !== 'object') {
    return { deleted: false, reason: 'no ownership record' };
  }
  const { partitionId, storageRoot, partitionPath, ownerUid, storageRootIdentity } = ownership;

  if (ownerUid !== currentUid()) {
    return {
      deleted: false,
      reason: `recorded owner uid ${ownerUid} is not the current uid ${currentUid()}`,
    };
  }

  let expectedPartitionPath;
  try {
    expectedPartitionPath = partitionPathFor(storageRoot, partitionId);
  } catch (error) {
    return { deleted: false, reason: error.message };
  }
  if (expectedPartitionPath !== partitionPath) {
    return {
      deleted: false,
      reason: `${partitionPath} is not the canonical partition path for ${partitionId}`,
    };
  }
  const root = ompSessionsRoot(storageRoot);
  if (path.dirname(expectedPartitionPath) !== root) {
    return {
      deleted: false,
      reason: `${expectedPartitionPath} does not resolve directly under ${root}`,
    };
  }
  // Defence in depth: OMP's shared, cross-session CAS root must never be reachable from a
  // partition path, whatever a tampered or migrated storageRoot claims.
  if (isInsideOmpBlobsDir(expectedPartitionPath) || isInsideOmpBlobsDir(root)) {
    return {
      deleted: false,
      reason: `${expectedPartitionPath} resolves inside the shared OMP blob store; refusing to delete`,
    };
  }

  // omp-sessions/ is the directory the staging rename happens inside, so it has to be a real,
  // owner-held directory reached without following a symlink before anything is moved into it.
  let rootPin;
  try {
    rootPin = pinDirectoryIdentity(root);
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already absent' };
    return { deleted: false, reason: `${root}: ${error.message}` };
  }
  if (String(rootPin.uid) !== currentUid()) {
    return { deleted: false, reason: `${root} is not owned by the current user` };
  }

  let storagePin;
  try {
    storagePin = pinDirectoryIdentity(path.resolve(storageRoot));
  } catch (error) {
    return { deleted: false, reason: `${storageRoot}: ${error.message}` };
  }
  if (!sameIdentity(storagePin.identity, storageRootIdentity)) {
    return {
      deleted: false,
      reason: `${storageRoot} identity ${storagePin.identity.device}:${storagePin.identity.inode} does not match the recorded ${storageRootIdentity?.device}:${storageRootIdentity?.inode}`,
    };
  }
  if (String(storagePin.uid) !== currentUid()) {
    return { deleted: false, reason: `${storageRoot} is not owned by the current user` };
  }

  let before;
  try {
    before = pinDirectoryIdentity(expectedPartitionPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already absent' };
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      return { deleted: false, reason: `${expectedPartitionPath} is a symlink; refusing to delete` };
    }
    if (error.code === 'ENOTDIR') {
      return {
        deleted: false,
        reason: `${expectedPartitionPath} is not a real directory; refusing to delete`,
      };
    }
    return { deleted: false, reason: error.message };
  }
  if (String(before.uid) !== currentUid()) {
    return { deleted: false, reason: `${expectedPartitionPath} is not owned by the current user` };
  }
  if (ownership.partitionIdentity && !sameIdentity(before.identity, ownership.partitionIdentity)) {
    return {
      deleted: false,
      reason: `${expectedPartitionPath} identity ${before.identity.device}:${before.identity.inode} does not match the recorded ${ownership.partitionIdentity.device}:${ownership.partitionIdentity.inode}`,
    };
  }

  const stagingPath = path.join(root, `${DELETING_PREFIX}${randomUUID()}`);
  try {
    fs.renameSync(expectedPartitionPath, stagingPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already absent' };
    return { deleted: false, reason: `could not stage ${expectedPartitionPath}: ${error.message}` };
  }

  let after;
  try {
    after = pinDirectoryIdentity(stagingPath);
  } catch (error) {
    return {
      deleted: false,
      reason: `staged ${stagingPath} could not be pinned (${error.message}); left in place for inspection`,
    };
  }
  if (!sameIdentity(after.identity, before.identity)) {
    return {
      deleted: false,
      reason: `${expectedPartitionPath} was substituted before deletion; the staged directory ${stagingPath} was left in place for inspection`,
    };
  }

  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  } catch (error) {
    return { deleted: false, reason: `${stagingPath}: ${error.message}` };
  }
  return { deleted: true };
}

module.exports = {
  DELETING_PREFIX,
  OMP_SESSIONS_SUBDIR,
  PARTITION_ID_PATTERN,
  ompSessionsRoot,
  partitionPathFor,
  generateOmpPartitionId,
  createOmpSessionPartitionDirectory,
  allocateOmpSessionPartition,
  deleteOmpSessionPartition,
};
