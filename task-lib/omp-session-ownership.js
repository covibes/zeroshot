// Owner-fenced transitions for task.ompSessionOwnership (schema v5).
//
// Every transition is a SQL compare-and-swap against the *exact* JSON currently persisted for that
// row, so a duplicate or re-entrant completion call (two crash-recovery paths racing, a retried
// hook, a watcher and its parent both reacting to the same terminal frame) can never clobber a
// state a concurrent writer already advanced past. `store.js` always writes this column through
// `serializeOmpSessionOwnership`, whose output is canonical for a given record, which is what makes
// full-value CAS byte-stable.
//
// State machine, identical for fresh and resumed turns:
//
//   (row inserted)        provisional
//   materialization       provisional + observation      recordVerifiedMaterialization / commitOwnership
//   success boundary      committed                      commitOwnership / commitRecordedOwnership
//   any other boundary    cleanup-required               markCleanupRequired
//
// A resumed turn additionally performs `transferOmpSessionOwnership` before its prompt is written:
// in one transaction the prior committed owner's record is cleared and its lineage (partition
// identity + session tuple) is moved onto the resumed task's still-`provisional` row. That keeps
// exactly one row referencing the partition at all times and keeps "committed" meaning what it
// means everywhere else — this turn's own success boundary has passed — instead of publishing a
// half-finished continuation as resumable.
import { basename } from 'path';
import { statSync } from 'fs';
import { getTask, getTaskStoreDatabase } from './store.js';
import {
  buildProvisionalOwnership,
  computeExecutionFingerprint,
  serializeOmpSessionOwnership,
  validateOmpSessionOwnership,
  validateOwnedByTask,
} from './omp-session-ownership-schema.js';

export { computeExecutionFingerprint };

function statIdentity(targetPath) {
  const stat = statSync(targetPath);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

/** Pure builder for the initial provisional record; embed the result in the task row passed to
 * addTask() so the SQL row is durable before the partition directory is created on disk. */
export function writeProvisionalOwnership({
  partitionId,
  storageRoot,
  canonicalWorkspace,
  owner,
}) {
  return buildProvisionalOwnership({
    partitionId,
    storageRoot,
    storageRootIdentity: statIdentity(storageRoot),
    canonicalWorkspace,
    owner,
  });
}

/** Read a row's ownership record, fenced to that row: a well-formed record whose `owner.taskId` is
 * some other task is not this row's ownership and is never returned. */
export function readOwnership(taskId) {
  return validateOwnedByTask(getTask(taskId)?.ompSessionOwnership ?? null, taskId);
}

/**
 * Compare-and-swap the whole record. `expected` must be the record as currently persisted; a
 * concurrent writer that has already changed the row makes this a no-op returning false.
 */
function casOwnership(taskId, expected, next) {
  const validatedNext = validateOwnedByTask(next, taskId);
  if (!validatedNext) return false;
  const expectedJson = serializeOmpSessionOwnership(expected);
  const database = getTaskStoreDatabase();
  const result = database
    .prepare(
      `UPDATE tasks SET omp_session_ownership = ?, updated_at = ?
       WHERE id = ? AND omp_session_ownership = ?`
    )
    .run(
      serializeOmpSessionOwnership(validatedNext),
      new Date().toISOString(),
      taskId,
      expectedJson
    );
  return result.changes === 1;
}

/** Shape the observed materialization evidence. Returns null (never throws) if a stat fails. */
function buildObservedEvidence(
  current,
  {
    sessionId,
    sessionFilePath,
    partitionIdentity,
    sessionFileIdentity,
    artifactManifestDigest,
    executionFingerprint,
    selectedProvider,
    selectedModel,
  }
) {
  try {
    return {
      // The verifier hands back descriptor-pinned identities; fall back to a stat only when a
      // caller (a test double, or a path that never ran the verifier) did not supply them.
      partitionIdentity: partitionIdentity ?? statIdentity(current.partitionPath),
      session: {
        sessionId,
        fileName: basename(sessionFilePath),
        fileIdentity: sessionFileIdentity ?? statIdentity(sessionFilePath),
        artifactManifestDigest,
        executionFingerprint,
        selectedProvider,
        selectedModel,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Persist owner-fenced verified materialization evidence WITHOUT advancing state. Used by the
 * detached RPC watcher for cluster-agent owners: the watcher verifies the terminal session file
 * itself (two-phase file contract) but must never decide "committed" on its own — that decision
 * belongs to the parent agent process's post-hook success boundary (see commitRecordedOwnership).
 * Fails closed (returns false, never throws) when the record is missing, is not this task's, has
 * already left `provisional`, or the evidence does not validate.
 */
export function recordVerifiedMaterialization({ taskId, ...evidence }) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  const observed = buildObservedEvidence(current, evidence);
  if (!observed) return false;
  return casOwnership(taskId, current, { ...current, state: 'provisional', ...observed });
}

/**
 * Commit a provisional record once the terminal boundary for this task's owner kind has actually
 * succeeded (standalone: the watcher's own output validation; cluster-agent: logical/schema/
 * onComplete hook success). Fails closed (returns false, never throws); the caller must treat a
 * false return as "did not commit" and mark cleanup-required instead.
 */
export function commitOwnership({ taskId, ...evidence }) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  const observed = buildObservedEvidence(current, evidence);
  if (!observed) return false;
  return casOwnership(taskId, current, { ...current, state: 'committed', ...observed });
}

/**
 * Commit using evidence the watcher already recorded via recordVerifiedMaterialization — never
 * re-verifies the partition. This is the ONLY path that may advance a cluster-agent owner to
 * `committed`, and only from the post-hook success boundary in src/agent/agent-lifecycle.js:
 * committing earlier would let a later turn resume a turn whose logical/schema output or
 * onComplete hook subsequently failed. Returns false when no verified evidence exists yet.
 */
export function commitRecordedOwnership(taskId) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  if (!current.partitionIdentity || !current.session) return false;
  return casOwnership(taskId, current, { ...current, state: 'committed' });
}

/**
 * Mark a still-provisional record cleanup-required on any failed, cancelled, or uncertain terminal
 * boundary. No-op once a record has left `provisional`: a `committed` record is never downgraded,
 * because commit is strictly the last action of an already-successful turn — and a resumed turn is
 * provisional right up to that same boundary (see transferOmpSessionOwnership), so retiring a
 * failed continuation needs no exception here.
 */
export function markCleanupRequired(taskId) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return current;
  const updated = { ...current, state: 'cleanup-required' };
  return casOwnership(taskId, current, updated) ? updated : readOwnership(taskId);
}

/** Rows other than `excludeTaskId` that still hold a committed record for this partition. Cleanup
 * consults this so a partition whose committed owner is a *different* row (a resume that crashed
 * before its ownership transfer, leaving the prior owner still committed) is never deleted out
 * from under that owner. */
export function findCommittedOwnersForPartition(partitionId, excludeTaskId = null) {
  const database = getTaskStoreDatabase();
  const rows = database
    .prepare(
      `SELECT id, omp_session_ownership FROM tasks
       WHERE omp_session_ownership IS NOT NULL
         AND json_extract(omp_session_ownership, '$.partitionId') = ?
         AND json_extract(omp_session_ownership, '$.state') = 'committed'`
    )
    .all(partitionId);
  return rows
    .filter((row) => row.id !== excludeTaskId)
    .filter((row) => validateOwnedByTask(JSON.parse(row.omp_session_ownership), row.id))
    .map((row) => row.id);
}

/**
 * Atomically move a committed partition's ownership from `fromTaskId` to `toTaskId`, before the
 * resumed turn's prompt is written.
 *
 * Both sides are fenced on their exact current JSON inside one transaction, so the outcome is all
 * or nothing: either the prior owner's record is cleared *and* the resumed row carries the
 * inherited lineage, or nothing changed and the caller must fail the turn closed. There is never a
 * window in which two rows are committed owners of the same partition, nor one in which the
 * partition has no owner row at all.
 *
 * Returns the transferred record, or null when the transfer did not apply (prior owner already
 * moved, resumed row already advanced, lineage mismatch).
 */
export function transferOmpSessionOwnership({ fromTaskId, toTaskId }) {
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return null;
  const prior = readOwnership(fromTaskId);
  const incoming = readOwnership(toTaskId);
  if (!prior || prior.state !== 'committed' || !prior.session || !prior.partitionIdentity) {
    return null;
  }
  if (!incoming || incoming.state !== 'provisional') return null;
  if (
    incoming.partitionId !== prior.partitionId ||
    incoming.partitionPath !== prior.partitionPath ||
    incoming.storageRoot !== prior.storageRoot
  ) {
    return null;
  }

  const transferred = {
    ...incoming,
    state: 'provisional',
    partitionIdentity: prior.partitionIdentity,
    session: prior.session,
  };
  if (!validateOwnedByTask(transferred, toTaskId)) return null;

  const database = getTaskStoreDatabase();
  const now = new Date().toISOString();
  const priorJson = serializeOmpSessionOwnership(prior);
  const incomingJson = serializeOmpSessionOwnership(incoming);
  const transferredJson = serializeOmpSessionOwnership(transferred);

  const apply = database.transaction(() => {
    const released = database
      .prepare(
        `UPDATE tasks SET omp_session_ownership = NULL, updated_at = ?
         WHERE id = ? AND omp_session_ownership = ?`
      )
      .run(now, fromTaskId, priorJson);
    if (released.changes !== 1) throw new Error('prior-owner-moved');
    const claimed = database
      .prepare(
        `UPDATE tasks SET omp_session_ownership = ?, updated_at = ?
         WHERE id = ? AND omp_session_ownership = ?`
      )
      .run(transferredJson, now, toTaskId, incomingJson);
    if (claimed.changes !== 1) throw new Error('resumed-owner-moved');
  });

  try {
    apply();
  } catch {
    return null;
  }
  return validateOmpSessionOwnership(transferred);
}
