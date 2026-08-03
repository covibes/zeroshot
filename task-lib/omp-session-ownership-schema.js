// Pure (no DB, no partition I/O) validation/canonicalization for the closed
// `task.ompSessionOwnership` JSON shape defined by issue #866. Kept dependency-free of
// task-lib/store.js so store.js can import this module for parse/serialize without a cycle; the
// DB-touching transitions (provisional -> committed / cleanup-required, owner transfer) live in
// task-lib/omp-session-ownership.js.
//
// The schema is *closed* in both directions: an unknown key anywhere in the object (top level,
// `owner`, `session`, or either identity) rejects the whole record, and every known key is
// re-derived into a canonical form on the way out. A record that does not validate is never
// partially trusted — callers fail closed to a fresh context.
import { isAbsolute, resolve as resolvePath } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PARTITION_ID_PATTERN, partitionPathFor } = require('../src/omp-session-partition.js');

export const OMP_OWNERSHIP_SCHEMA_VERSION = 1;
export const OMP_OWNERSHIP_STATES = Object.freeze(['provisional', 'committed', 'cleanup-required']);

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const SESSION_FILE_NAME_PATTERN = /^[^/\\]+\.jsonl$/u;
const STATES = new Set(OMP_OWNERSHIP_STATES);
const OWNER_KINDS = new Set(['cluster-agent', 'standalone']);

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'state',
  'partitionId',
  'storageRoot',
  'partitionPath',
  'ownerUid',
  'storageRootIdentity',
  'partitionIdentity',
  'canonicalWorkspace',
  'owner',
  'session',
]);
const OWNER_KEYS = new Set(['kind', 'clusterId', 'agentId', 'taskId']);
const SESSION_KEYS = new Set([
  'sessionId',
  'fileName',
  'fileIdentity',
  'artifactManifestDigest',
  'executionFingerprint',
  'selectedProvider',
  'selectedModel',
]);
const IDENTITY_KEYS = new Set(['device', 'inode']);

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isDecimalString(value) {
  return isNonEmptyString(value) && DECIMAL_PATTERN.test(value);
}

function isDigest(value) {
  return isNonEmptyString(value) && SHA256_PATTERN.test(value);
}

/** A canonical absolute path: already fully resolved, so a record can never smuggle in a relative,
 * `..`-bearing, or trailing-separator path that would resolve differently at cleanup time. */
function isCanonicalAbsolutePath(value) {
  return isNonEmptyString(value) && isAbsolute(value) && resolvePath(value) === value;
}

function normalizeIdentity(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, IDENTITY_KEYS)) return null;
  if (!isDecimalString(value.device) || !isDecimalString(value.inode)) return null;
  return { device: value.device, inode: value.inode };
}

export function canonicalOwnerUid() {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '0';
}

function normalizeOwner(owner) {
  if (!isPlainObject(owner) || !hasOnlyKeys(owner, OWNER_KEYS)) return null;
  if (!OWNER_KINDS.has(owner.kind)) return null;
  if (!isNonEmptyString(owner.taskId)) return null;
  if (owner.kind === 'cluster-agent') {
    if (!isNonEmptyString(owner.clusterId) || !isNonEmptyString(owner.agentId)) return null;
  } else if (owner.clusterId !== null || owner.agentId !== null) {
    return null;
  }
  return {
    kind: owner.kind,
    clusterId: owner.clusterId,
    agentId: owner.agentId,
    taskId: owner.taskId,
  };
}

function normalizeSession(session) {
  if (!isPlainObject(session) || !hasOnlyKeys(session, SESSION_KEYS)) return null;
  const fileIdentity = normalizeIdentity(session.fileIdentity);
  if (
    !isNonEmptyString(session.sessionId) ||
    !isNonEmptyString(session.fileName) ||
    !SESSION_FILE_NAME_PATTERN.test(session.fileName) ||
    session.fileName === '.jsonl' ||
    !fileIdentity ||
    !isDigest(session.artifactManifestDigest) ||
    !isDigest(session.executionFingerprint) ||
    !isNonEmptyString(session.selectedProvider) ||
    !isNonEmptyString(session.selectedModel)
  ) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    fileName: session.fileName,
    fileIdentity,
    artifactManifestDigest: session.artifactManifestDigest,
    executionFingerprint: session.executionFingerprint,
    selectedProvider: session.selectedProvider,
    selectedModel: session.selectedModel,
  };
}

/**
 * Validate and canonicalize an arbitrary value as a closed `task.ompSessionOwnership` object.
 * Returns null on any structural violation.
 */
export function validateOmpSessionOwnership(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) return null;
  if (value.schemaVersion !== OMP_OWNERSHIP_SCHEMA_VERSION) return null;
  if (!STATES.has(value.state)) return null;
  if (!isNonEmptyString(value.partitionId) || !PARTITION_ID_PATTERN.test(value.partitionId)) {
    return null;
  }
  if (!isCanonicalAbsolutePath(value.storageRoot)) return null;
  if (!isCanonicalAbsolutePath(value.partitionPath)) return null;
  if (!isCanonicalAbsolutePath(value.canonicalWorkspace)) return null;
  // The partition path is fully determined by storageRoot + partitionId. Re-deriving it (instead
  // of trusting the stored string) is what stops a tampered row from pointing cleanup or a resume
  // at an arbitrary directory that merely *looks* canonical.
  let derivedPartitionPath;
  try {
    derivedPartitionPath = partitionPathFor(value.storageRoot, value.partitionId);
  } catch {
    return null;
  }
  if (derivedPartitionPath !== value.partitionPath) return null;
  if (!isDecimalString(value.ownerUid)) return null;

  const storageRootIdentity = normalizeIdentity(value.storageRootIdentity);
  if (!storageRootIdentity) return null;

  const owner = normalizeOwner(value.owner);
  if (!owner) return null;

  if (!Object.hasOwn(value, 'partitionIdentity') || !Object.hasOwn(value, 'session')) return null;
  const hasPartitionIdentity = value.partitionIdentity !== null;
  const hasSession = value.session !== null;
  // No partially populated pairs, in any state: an observation of the materialized session is
  // either complete (both the partition identity and the full session tuple) or absent.
  if (hasPartitionIdentity !== hasSession) return null;
  const partitionIdentity = hasPartitionIdentity
    ? normalizeIdentity(value.partitionIdentity)
    : null;
  const session = hasSession ? normalizeSession(value.session) : null;
  if (hasPartitionIdentity && (!partitionIdentity || !session)) return null;
  // `committed` is the only state that asserts a resumable session, so it is the only state that
  // requires the observation to be present.
  if (value.state === 'committed' && !session) return null;

  return {
    schemaVersion: OMP_OWNERSHIP_SCHEMA_VERSION,
    state: value.state,
    partitionId: value.partitionId,
    storageRoot: value.storageRoot,
    partitionPath: value.partitionPath,
    ownerUid: value.ownerUid,
    storageRootIdentity,
    partitionIdentity,
    canonicalWorkspace: value.canonicalWorkspace,
    owner,
    session,
  };
}

/**
 * Validate a record *and* fence it to the task row it was read from: an ownership record whose
 * `owner.taskId` is not this row's id is not this row's ownership, however well-formed it is.
 */
export function validateOwnedByTask(value, taskId) {
  const validated = validateOmpSessionOwnership(value);
  if (!validated) return null;
  if (!isNonEmptyString(taskId) || validated.owner.taskId !== taskId) return null;
  return validated;
}

/** Build the initial provisional ownership record. Pure — the directory need not exist yet. */
export function buildProvisionalOwnership({
  partitionId,
  storageRoot,
  storageRootIdentity,
  canonicalWorkspace,
  owner,
}) {
  const canonicalStorageRoot = resolvePath(storageRoot);
  const record = {
    schemaVersion: OMP_OWNERSHIP_SCHEMA_VERSION,
    state: 'provisional',
    partitionId,
    storageRoot: canonicalStorageRoot,
    partitionPath: partitionPathFor(canonicalStorageRoot, partitionId),
    ownerUid: canonicalOwnerUid(),
    storageRootIdentity,
    partitionIdentity: null,
    canonicalWorkspace: resolvePath(canonicalWorkspace),
    owner,
    session: null,
  };
  const validated = validateOmpSessionOwnership(record);
  if (!validated) {
    throw new Error('buildProvisionalOwnership produced an invalid ownership record.');
  }
  return validated;
}

export function parseOmpSessionOwnership(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateOmpSessionOwnership(parsed);
}

/**
 * Closed raw-column inspection seam for a stored `omp_session_ownership` value.
 *
 * `parseOmpSessionOwnership` collapses *both* "SQL NULL" and "non-null but unreadable" to `null`,
 * and those two mean opposite things to cleanup: SQL NULL is exact truth that there is nothing to
 * clean, while unreadable bytes are evidence that a partition may exist whose owner record we can
 * no longer interpret. Deleting such a row would orphan that partition permanently, so every
 * cleanup surface needs to tell them apart.
 *
 * The seam is deliberately closed: it reports only `{present, valid}` and never hands the raw text
 * back, so nothing downstream can be tempted to parse, canonicalize, or act on malformed JSON.
 */
export function inspectStoredOmpSessionOwnership(raw) {
  if (raw === null || raw === undefined) return { present: false, valid: false };
  return { present: true, valid: parseOmpSessionOwnership(raw) !== null };
}

export function serializeOmpSessionOwnership(value) {
  if (!value) return null;
  const validated = validateOmpSessionOwnership(value);
  if (!validated) {
    throw new Error('Refusing to persist an invalid ompSessionOwnership record.');
  }
  return JSON.stringify(validated);
}
