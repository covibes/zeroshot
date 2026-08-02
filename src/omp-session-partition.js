const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Every OMP session partition lives under <storageRoot>/omp-sessions/<uuid>/. storageRoot is the
// owning cluster's storageDir for cluster-agent tasks or the standalone TASKS_DIR otherwise (see
// task-lib/omp-storage-root.js) — never derived from prompt text or cwd.
const OMP_SESSIONS_SUBDIR = 'omp-sessions';
const PARTITION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function ompSessionsRoot(storageRoot) {
  return path.join(path.resolve(storageRoot), OMP_SESSIONS_SUBDIR);
}

function partitionPathFor(storageRoot, partitionId) {
  if (!PARTITION_ID_PATTERN.test(partitionId)) {
    throw new Error(`Invalid OMP session partition id: ${partitionId}`);
  }
  return path.join(ompSessionsRoot(storageRoot), partitionId);
}

function generateOmpPartitionId() {
  return randomUUID();
}

/** Owner-only (0700) directory creation. Idempotent: safe to call once the row referencing this
 * partitionId is already durable (row-before-directory — see task-lib/omp-session-ownership.js). */
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

/**
 * Delete one partition directory, never the shared `.blobs` CAS root or any path outside
 * `<storageRoot>/omp-sessions/`. Never throws: an unsafe/unresolvable path is left intact with an
 * actionable reason so the caller can warn instead of silently losing the owner record.
 */
function deleteOmpSessionPartition(storageRoot, partitionId) {
  let partitionPath;
  try {
    partitionPath = partitionPathFor(storageRoot, partitionId);
  } catch (error) {
    return { deleted: false, reason: error.message };
  }
  const root = ompSessionsRoot(storageRoot);
  if (path.dirname(partitionPath) !== root) {
    return { deleted: false, reason: `${partitionPath} does not resolve directly under ${root}.` };
  }
  let stat;
  try {
    stat = fs.lstatSync(partitionPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true, reason: 'already absent' };
    return { deleted: false, reason: error.message };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      deleted: false,
      reason: `${partitionPath} is not a real directory; refusing to delete.`,
    };
  }
  try {
    fs.rmSync(partitionPath, { recursive: true, force: true });
  } catch (error) {
    return { deleted: false, reason: error.message };
  }
  return { deleted: true };
}

module.exports = {
  OMP_SESSIONS_SUBDIR,
  PARTITION_ID_PATTERN,
  ompSessionsRoot,
  partitionPathFor,
  generateOmpPartitionId,
  createOmpSessionPartitionDirectory,
  allocateOmpSessionPartition,
  deleteOmpSessionPartition,
};
