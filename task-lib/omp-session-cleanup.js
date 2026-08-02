// The single implementation behind all three OMP session-partition cleanup surfaces required by
// issue #866: standalone task `clean` (task-lib/commands/clean.js), cluster clear
// (cli/index.js deleteClusterData, also reached by `zeroshot purge`), and global `purge`
// (cli/index.js, which runs cluster clear then `clean --all`).
//
// Three invariants hold on every surface:
//   * A committed session stays available for resume until its own task record is being removed —
//     cleanup is driven by the task row, never by scanning the partition tree for orphans.
//   * A partition is never deleted while any *other* row holds an authoritative claim on it.
//     Several rows can name one partition at once: a resumed row is inserted before its owner
//     transfer runs, so two competing resumes of one committed session put three rows on it. The
//     fence is therefore over every authoritative row (provisional or committed), never over the
//     committed rows alone — after a transfer the live owner is `provisional` and no row is
//     committed at all.
//   * The shared, machine-wide OMP CAS blob root (src/omp-blob-root.js) is never touched. Blobs
//     are addressed from *other* sessions' JSONL too, so deleting one is data loss for unrelated
//     work; stageOmpSessionPartitionForDeletion refuses any path that resolves inside it.
//
// An unsafe or unresolvable path preserves the owner record with an actionable warning instead of
// deleting, so the operator can inspect it and the cleanup stays durably retryable.
import {
  loadTasks,
  updateTask,
  getTaskStoreDatabase,
  hasUnreadableOmpSessionOwnership,
} from './store.js';
import { findAuthoritativeOwnersForPartition } from './omp-session-ownership.js';
import {
  serializeOmpSessionOwnership,
  validateOwnedByTask,
} from './omp-session-ownership-schema.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  removeStagedOmpSessionPartition,
  stageOmpSessionPartitionForDeletion,
} = require('../src/omp-session-partition.js');

/**
 * Take the partition away from its canonical name under a task-store write fence, then remove the
 * staged tree outside it.
 *
 * The fence spans exactly three steps: "this row still holds the record cleanup validated", "no
 * other row holds an authoritative claim on this partition", and "the partition no longer answers
 * to its canonical name". Without it, a resume could insert its provisional row — or win its
 * ownership transfer — in the gap between the checks and the rename, and cleanup would move a live
 * session out from under it. `BEGIN IMMEDIATE` takes the write lock up front, so every competing
 * ownership write is serialized either wholly before the checks (and is therefore seen by them) or
 * wholly after the rename, where it lands on a partition that is already gone and fails that turn
 * closed rather than costing a live one its data.
 *
 * The row re-read closes the same race from the caller's side: every cleanup surface iterates a
 * task snapshot taken by an earlier `loadTasks()`, and a resume that transferred this partition
 * away in the meantime leaves that snapshot describing a record the row no longer holds — acting
 * on it would delete the partition on behalf of an owner that has already released it. `store.js`
 * writes this column only through `serializeOmpSessionOwnership`, whose output is canonical per
 * record, so comparing the stored bytes is an exact "still the same record" test.
 *
 * The recursive removal runs *after* the fence is released, because by then the tree only answers
 * to an unguessable staging name nothing else knows, and holding a write lock across an
 * arbitrarily large `rm -r` would stall every other task-store writer.
 */
function stageUnderOwnerFence(ownership, taskId) {
  const database = getTaskStoreDatabase();
  const expectedRecord = serializeOmpSessionOwnership(ownership);
  const readRecord = database.prepare(
    'SELECT omp_session_ownership AS record FROM tasks WHERE id = ?'
  );
  const fenced = database.transaction(() => {
    const row = readRecord.get(taskId);
    if (!row || row.record !== expectedRecord) {
      return {
        staged: false,
        deleted: false,
        reason: 'its ownership record changed while cleanup was running',
      };
    }
    const owners = findAuthoritativeOwnersForPartition(ownership.partitionId, taskId, database);
    if (owners.length > 0) {
      return {
        staged: false,
        deleted: false,
        reason: `it is still claimed by ${owners.map((o) => `${o.taskId} (${o.state})`).join(', ')}`,
      };
    }
    return stageOmpSessionPartitionForDeletion(ownership);
  });
  // BEGIN IMMEDIATE: take the write lock up front so the checks cannot run under a shared lock that
  // another writer is simultaneously upgrading.
  return fenced.immediate();
}

/**
 * Delete one task's OMP session partition. Returns true when the task row is now safe to remove
 * (nothing to clean, or the partition is gone).
 *
 * @param {object} task task record as returned by the store
 * @param {(message: string) => void} warn receives an actionable message for a retained partition
 * @param {{clearRecord?: boolean}} options `clearRecord` NULLs the row's ownership after a
 *   successful delete — required on surfaces (cluster clear) where the row itself survives.
 */
export function cleanupOmpSessionPartitionForTask(task, warn, { clearRecord = false } = {}) {
  // A SQL-NULL ownership column is exact truth that this task never allocated a partition: there
  // is nothing to clean and the row is free to go. An *unreadable* column is the opposite — some
  // partition may exist that only this row still points at — so the row and its evidence are
  // retained for an operator instead of being deleted into an orphan. The malformed bytes are
  // never parsed, canonicalized, or otherwise acted on.
  if (hasUnreadableOmpSessionOwnership(task)) {
    warn(
      `Task ${task.id}: OMP session ownership record is present but unreadable; retaining the task row and its record for inspection. Nothing was deleted, and any partition it named must be reclaimed manually.`
    );
    return false;
  }
  if (!task?.ompSessionOwnership) return true;
  const ownership = validateOwnedByTask(task.ompSessionOwnership, task.id);
  if (!ownership) {
    warn(
      `Task ${task.id}: retained an OMP session ownership record that failed validation; nothing was deleted.`
    );
    return false;
  }

  // More than one row can name a single partition: a resume inserts its provisional row before its
  // ownership transfer runs, and two competing resumes of one committed session put three rows on
  // it. The fence is therefore every *authoritative* (provisional or committed) claim other than
  // this row's — a crashed-before-transfer resume must not delete the prior owner's still-resumable
  // session, and a losing competing resume must not delete the winner's live one.
  const staged = stageUnderOwnerFence(ownership, task.id);
  if (!staged.staged) {
    if (staged.deleted) return finishCleanup(task, clearRecord);
    warn(
      `Task ${task.id}: retained OMP session partition ${ownership.partitionId} (${staged.reason}).`
    );
    return false;
  }

  const { deleted, reason } = removeStagedOmpSessionPartition(staged.stagingPath);
  if (!deleted) {
    warn(`Task ${task.id}: retained OMP session partition ${ownership.partitionId} (${reason}).`);
    return false;
  }
  return finishCleanup(task, clearRecord);
}

function finishCleanup(task, clearRecord) {
  if (clearRecord) {
    updateTask(task.id, { ompSessionOwnership: null });
  }
  return true;
}

/**
 * Delete every OMP session partition owned by a cluster's agents. Cluster partitions live under
 * the cluster's own `storageDir`, so this is what makes cluster clear (and therefore purge)
 * actually reclaim them; the task rows themselves survive and have their ownership cleared.
 *
 * A row whose ownership column is present but unreadable cannot be attributed to a cluster at all
 * — the owner tuple is exactly what is unreadable — so it is reported separately (`unreadable`)
 * rather than silently skipped. Cluster clear keeps task rows, so the evidence survives either way;
 * the warning is what tells the operator a partition may need reclaiming by hand.
 *
 * @returns {{deleted: string[], retained: string[], unreadable: string[]}} partition ids, plus the
 *   task ids whose ownership record could not be read
 */
export function cleanupOmpSessionPartitionsForCluster(clusterId, warn) {
  const deleted = [];
  const retained = [];
  const unreadable = [];
  if (!clusterId) return { deleted, retained, unreadable };

  for (const task of Object.values(loadTasks())) {
    if (hasUnreadableOmpSessionOwnership(task)) {
      unreadable.push(task.id);
      warn(
        `Task ${task.id}: OMP session ownership record is present but unreadable, so it cannot be attributed to a cluster; the row and its record are retained for inspection.`
      );
      continue;
    }
    const ownership = validateOwnedByTask(task?.ompSessionOwnership ?? null, task?.id);
    if (!ownership || ownership.owner.kind !== 'cluster-agent') continue;
    if (ownership.owner.clusterId !== clusterId) continue;
    if (cleanupOmpSessionPartitionForTask(task, warn, { clearRecord: true })) {
      deleted.push(ownership.partitionId);
    } else {
      retained.push(ownership.partitionId);
    }
  }
  return { deleted, retained, unreadable };
}
