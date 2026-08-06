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
// identity + session tuple) is moved onto the resumed task's still-`provisional` row.
//
// That means a partition has at most one *committed* owner, and for the whole span of a resumed
// turn it has NONE: the authoritative live claimant is `provisional` by design, because
// "committed" means this row's own success boundary has already passed. Publishing a half-finished
// continuation as resumable is exactly what that ordering prevents.
//
// It also does NOT keep exactly one row *referencing* the partition. A resumed row is inserted (and
// therefore already names the partition) before its transfer runs, so two competing resumes of the
// same committed session put three rows on one partition: the prior owner plus both candidates.
// Only one transfer can win; the loser fails closed and is retired to `cleanup-required` holding a
// record that still names the partition but carries no lineage of its own. Anything that acts on a
// partition — cleanup above all — must therefore fence on *every* row that references it
// (`findAuthoritativeOwnersForPartition`), never on the committed rows alone and never on the
// assumption that its own row is the only claimant.
import { basename } from 'path';
import { statSync } from 'fs';
import { getTask, getTaskStoreDatabase } from './store.js';
import {
  buildProvisionalOwnership,
  parseOmpSessionOwnership,
  serializeOmpSessionOwnership,
  validateOmpSessionOwnership,
  validateOwnedByTask,
} from './omp-session-ownership-schema.js';

function statIdentity(targetPath) {
  const stat = statSync(targetPath);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

/** Pure builder for the initial provisional record; embed the result in the task row passed to
 * addTask() so the SQL row is durable before the partition directory is created on disk. */
export function writeProvisionalOwnership({ partitionId, storageRoot, canonicalWorkspace, owner }) {
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

/**
 * Retire a task's OMP ownership from a *confirmed durable task boundary* — a failed, cancelled,
 * stale, or killed transition — without ever letting that retirement break the boundary itself.
 *
 * Every caller here is already committing a terminal task-status write (task-lib/runner.js's
 * row-before-directory failure, `zeroshot task kill`, `zeroshot clear`, `zeroshot kill-all`), so
 * this must not throw: an unreachable or locked task store must not turn "the task is killed" into
 * an unhandled rejection. It is idempotent and safe to re-enter — `markCleanupRequired` no-ops once
 * the record has left `provisional`, so a retried kill or a crash-recovery replay converges.
 *
 * The decision is derived from the boundary, never from whether the partition directory happens to
 * exist: a fresh partition can be mid-materialization at exactly this moment, and file presence
 * would answer the wrong question.
 *
 * @param {string} taskId
 * @param {(error: Error) => void} [onError] receives an unexpected store failure for logging
 * @returns {boolean} true when the retirement ran without error (including no-op cases)
 */
export function retireOmpOwnershipAtTerminalBoundary(taskId, onError) {
  if (typeof taskId !== 'string' || taskId.length === 0) return true;
  try {
    markCleanupRequired(taskId);
    return true;
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

/**
 * The ownership states that constitute a live claim on a partition.
 *
 * `provisional` is authoritative because it is the state a turn occupies while it is *using* the
 * partition — a fresh turn writing into it, and (post-transfer) a resumed turn continuing it right
 * up to its own success boundary. `committed` is authoritative because the session is resumable.
 *
 * `cleanup-required` is deliberately NOT authoritative: it is the state of a turn that has already
 * been retired and makes no further claim. Treating it as one would deadlock cleanup whenever two
 * retired rows name the same partition (the third-owner residue below) — each would refuse forever
 * on account of the other, and the partition could never be reclaimed by anybody.
 */
export const AUTHORITATIVE_OWNERSHIP_STATES = Object.freeze(['provisional', 'committed']);

const AUTHORITATIVE_STATES = new Set(AUTHORITATIVE_OWNERSHIP_STATES);

/** Every row other than `excludeTaskId` whose own valid record names this partition, plus every
 * unreadable or invalid non-null row as global unknown authoritative evidence. A malformed record
 * cannot safely prove which partition it names, so cleanup must assume it may name the partition
 * being considered; skipping it could orphan the only directory that damaged row still points at.
 *
 * The partition filter is applied in JS after validation rather than in SQL. SQLite's
 * `json_extract()` raises "malformed JSON" for a column whose bytes are not valid JSON. Reading the
 * column as opaque text both avoids that failure and lets cleanup represent corruption explicitly
 * instead of treating unknown evidence as absence. */
function ownersForPartition(partitionId, excludeTaskId, database) {
  const rows = database
    .prepare(
      `SELECT id, omp_session_ownership AS record FROM tasks
       WHERE omp_session_ownership IS NOT NULL`
    )
    .all();
  const owners = [];
  for (const row of rows) {
    if (row.id === excludeTaskId) continue;
    const record = parseOmpSessionOwnership(row.record);
    const owned = record && validateOwnedByTask(record, row.id);
    if (!owned) {
      owners.push({ taskId: row.id, state: null, unknown: true });
      continue;
    }
    if (owned.partitionId === partitionId) {
      owners.push({ taskId: row.id, state: owned.state });
    }
  }
  return owners;
}

/** Rows other than `excludeTaskId` that still hold a committed record for this partition — i.e.
 * the rows for which this partition is a *resumable* session. */
export function findCommittedOwnersForPartition(
  partitionId,
  excludeTaskId = null,
  database = getTaskStoreDatabase()
) {
  return ownersForPartition(partitionId, excludeTaskId, database)
    .filter((owner) => owner.state === 'committed')
    .map((owner) => owner.taskId);
}

/**
 * Rows other than `excludeTaskId` holding an authoritative (`provisional` or `committed`) claim on
 * this partition, as `{taskId, state}`.
 *
 * This is the owner fence cleanup runs on, and it is strictly wider than the committed owners:
 * after a resume's atomic transfer the winning row is `provisional` — it carries the whole
 * inherited lineage and is actively continuing the session, while *no* row is committed. A losing
 * competing resume, retired to `cleanup-required`, still names the same partition and holds no
 * lineage of its own, so a committed-only fence would see nothing and let it delete the winner's
 * live partition out from under it.
 *
 * `database` is injectable so a caller can run this inside its own write transaction (see
 * task-lib/omp-session-cleanup.js) rather than racing its own check.
 */
export function findAuthoritativeOwnersForPartition(
  partitionId,
  excludeTaskId = null,
  database = getTaskStoreDatabase()
) {
  return ownersForPartition(partitionId, excludeTaskId, database).filter(
    (owner) => owner.unknown || AUTHORITATIVE_STATES.has(owner.state)
  );
}

/**
 * Atomically move a committed partition's ownership from `fromTaskId` to `toTaskId`, before the
 * resumed turn's prompt is written.
 *
 * Both sides are fenced on their exact current JSON inside one transaction, so the outcome is all
 * or nothing: either the prior owner's record is cleared *and* the resumed row carries the
 * inherited lineage, or nothing changed and the caller must fail the turn closed. There is never a
 * window in which two rows are *committed* owners of the same partition.
 *
 * There is, however, a long window in which *no* row is committed: from the instant this transfer
 * applies until the resumed turn reaches its own success boundary, the authoritative claimant is
 * this `provisional` row. That is the intended steady state of a resumed turn, not a gap — which
 * is why every partition fence is over the authoritative states (see
 * findAuthoritativeOwnersForPartition) and not over the committed rows alone.
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
