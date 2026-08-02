// The single implementation behind all three OMP session-partition cleanup surfaces required by
// issue #866: standalone task `clean` (task-lib/commands/clean.js), cluster clear
// (cli/index.js deleteClusterData, also reached by `zeroshot purge`), and global `purge`
// (cli/index.js, which runs cluster clear then `clean --all`).
//
// Two invariants hold on every surface:
//   * A committed session stays available for resume until its own task record is being removed —
//     cleanup is driven by the task row, never by scanning the partition tree for orphans.
//   * The shared, machine-wide OMP CAS blob root (src/omp-blob-root.js) is never touched. Blobs
//     are addressed from *other* sessions' JSONL too, so deleting one is data loss for unrelated
//     work; deleteOmpSessionPartition refuses any path that resolves inside it.
//
// An unsafe or unresolvable path preserves the owner record with an actionable warning instead of
// deleting, so the operator can inspect it and the cleanup stays durably retryable.
import { loadTasks, updateTask } from './store.js';
import { findCommittedOwnersForPartition } from './omp-session-ownership.js';
import { validateOwnedByTask } from './omp-session-ownership-schema.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { deleteOmpSessionPartition } = require('../src/omp-session-partition.js');

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
  if (!task?.ompSessionOwnership) return true;
  const ownership = validateOwnedByTask(task.ompSessionOwnership, task.id);
  if (!ownership) {
    warn(
      `Task ${task.id}: retained an OMP session ownership record that failed validation; nothing was deleted.`
    );
    return false;
  }

  // A resume that crashed after its provisional row was written but before its ownership transfer
  // leaves two rows referencing one partition, only one of them committed. Deleting via the other
  // one would destroy a session its committed owner can still legitimately resume.
  const otherOwners = findCommittedOwnersForPartition(ownership.partitionId, task.id);
  if (otherOwners.length > 0) {
    warn(
      `Task ${task.id}: retained OMP session partition ${ownership.partitionId}; it is still committed to ${otherOwners.join(', ')}.`
    );
    return false;
  }

  const { deleted, reason } = deleteOmpSessionPartition(ownership);
  if (!deleted) {
    warn(`Task ${task.id}: retained OMP session partition ${ownership.partitionId} (${reason}).`);
    return false;
  }
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
 * @returns {{deleted: string[], retained: string[]}} partition ids
 */
export function cleanupOmpSessionPartitionsForCluster(clusterId, warn) {
  const deleted = [];
  const retained = [];
  if (!clusterId) return { deleted, retained };

  for (const task of Object.values(loadTasks())) {
    const ownership = validateOwnedByTask(task?.ompSessionOwnership ?? null, task?.id);
    if (!ownership || ownership.owner.kind !== 'cluster-agent') continue;
    if (ownership.owner.clusterId !== clusterId) continue;
    if (cleanupOmpSessionPartitionForTask(task, warn, { clearRecord: true })) {
      deleted.push(ownership.partitionId);
    } else {
      retained.push(ownership.partitionId);
    }
  }
  return { deleted, retained };
}
