// Owner-fenced transitions for task.ompSessionOwnership (schema v5). Every transition here is a
// SQL compare-and-swap against the persisted state so a duplicate/re-entrant completion call (two
// crash-recovery paths racing, or a retried hook) can never silently clobber a state a concurrent
// writer already advanced past.
import { basename } from 'path';
import { statSync } from 'fs';
import { getTask, getTaskStoreDatabase } from './store.js';
import {
  buildProvisionalOwnership,
  computeExecutionFingerprint,
  serializeOmpSessionOwnership,
  validateOmpSessionOwnership,
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
  partitionPath,
  canonicalWorkspace,
  owner,
}) {
  return buildProvisionalOwnership({
    partitionId,
    storageRoot,
    partitionPath,
    storageRootIdentity: statIdentity(storageRoot),
    canonicalWorkspace,
    owner,
  });
}

export function readOwnership(taskId) {
  return getTask(taskId)?.ompSessionOwnership ?? null;
}

function casUpdate(taskId, nextRecord) {
  const validated = validateOmpSessionOwnership(nextRecord);
  if (!validated) return false;
  const database = getTaskStoreDatabase();
  const result = database
    .prepare(
      `UPDATE tasks SET omp_session_ownership = ?, updated_at = ?
       WHERE id = ? AND json_extract(omp_session_ownership, '$.state') = 'provisional'`
    )
    .run(serializeOmpSessionOwnership(validated), new Date().toISOString(), taskId);
  return result.changes === 1;
}

/** Shared by recordVerifiedMaterialization/commitOwnership: stat the observed identities and
 * shape the session sub-object. Returns null (never throws) if either stat fails. */
function buildObservedEvidence(
  current,
  {
    sessionId,
    sessionFilePath,
    artifactManifestDigest,
    executionFingerprint,
    selectedProvider,
    selectedModel,
  }
) {
  try {
    return {
      partitionIdentity: statIdentity(current.partitionPath),
      session: {
        sessionId,
        fileName: basename(sessionFilePath),
        fileIdentity: statIdentity(sessionFilePath),
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
 * Persist owner-fenced verified materialization evidence (partitionIdentity/session) against a
 * still-'provisional' record WITHOUT advancing state. Used by the detached RPC watcher for
 * cluster-agent owners: the watcher verifies the terminal session file itself (two-phase file
 * contract) but must never decide "committed" on its own — that decision belongs to the parent
 * agent process's post-hook success boundary (see commitRecordedOwnership). Fails closed (returns
 * false, never throws) when the current record is missing, already advanced past 'provisional', or
 * the identity stat fails.
 */
export function recordVerifiedMaterialization({ taskId, ...evidence }) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  const observed = buildObservedEvidence(current, evidence);
  if (!observed) return false;
  return casUpdate(taskId, { ...current, state: 'provisional', ...observed });
}

/**
 * Commit a provisional ownership record to 'committed' once the terminal boundary for this task's
 * owner kind has actually succeeded (standalone: output validation; cluster-agent: logical/schema/
 * onComplete hook success). Fails closed (returns false, never throws) when the current record is
 * missing, already advanced past 'provisional', or the supplied evidence fails validation — the
 * caller must treat a false return as "did not commit" and mark cleanup-required instead.
 *
 * Standalone owners call this directly with fresh evidence (the watcher IS the terminal boundary
 * for standalone: there is no separate parent hook). Cluster-agent owners never call this from the
 * watcher — see commitRecordedOwnership, which commits evidence the watcher already recorded.
 */
export function commitOwnership({ taskId, ...evidence }) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  const observed = buildObservedEvidence(current, evidence);
  if (!observed) return false;
  return casUpdate(taskId, { ...current, state: 'committed', ...observed });
}

/**
 * Commit a provisional record using evidence the watcher already recorded via
 * recordVerifiedMaterialization — never re-verifies the partition itself. This is the ONLY path
 * that may advance a cluster-agent owner to 'committed', and it must only be called from the
 * existing post-hook success boundary (agent-lifecycle.js, after executeOnCompleteHookWithRetry
 * succeeds): committing here before that boundary would let a resume depend on a turn whose
 * logical/schema output or onComplete hook later turns out to have failed.
 * Fails closed (returns false) when no verified evidence has been recorded yet.
 */
export function commitRecordedOwnership(taskId) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return false;
  if (!current.partitionIdentity || !current.session) return false;
  return casUpdate(taskId, { ...current, state: 'committed' });
}

/**
 * Mark a still-provisional ownership record cleanup-required on any failed, cancelled, or
 * uncertain terminal boundary. No-op (returns the unchanged current record) once a record has
 * already left 'provisional' — a committed record is never downgraded by a failure path, since
 * commit only ever happens after every success condition already passed.
 */
export function markCleanupRequired(taskId) {
  const current = readOwnership(taskId);
  if (!current || current.state !== 'provisional') return current;
  const updated = { ...current, state: 'cleanup-required' };
  return casUpdate(taskId, updated) ? updated : readOwnership(taskId);
}
