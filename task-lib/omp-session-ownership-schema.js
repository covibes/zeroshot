// Pure (no DB, no partition I/O) validation/build helpers for the closed
// `task.ompSessionOwnership` JSON shape defined by issue #866. Kept dependency-free of
// task-lib/store.js so store.js can import this module for parse/serialize without a cycle; the
// DB-touching transitions (provisional -> committed / cleanup-required) live in
// task-lib/omp-session-ownership.js.
import { createHash } from 'crypto';
import { resolve as resolvePath } from 'path';

export const OMP_OWNERSHIP_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const STATES = new Set(['provisional', 'committed', 'cleanup-required']);
const OWNER_KINDS = new Set(['cluster-agent', 'standalone']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isDecimalString(value) {
  return isNonEmptyString(value) && DECIMAL_PATTERN.test(value);
}

function isDigest(value) {
  return isNonEmptyString(value) && SHA256_PATTERN.test(value);
}

function isIdentity(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isDecimalString(value.device) &&
    isDecimalString(value.inode)
  );
}

export function canonicalOwnerUid() {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '0';
}

/** sha256 over the UTF-8 bytes of a stable JSON encoding (sorted keys) of `fields`. */
export function computeExecutionFingerprint(fields) {
  const sortedKeys = Object.keys(fields).sort();
  const stable = {};
  for (const key of sortedKeys) stable[key] = fields[key];
  return `sha256:${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex')}`;
}

function validateOwner(owner) {
  if (!owner || typeof owner !== 'object') return false;
  if (!OWNER_KINDS.has(owner.kind)) return false;
  if (!isNonEmptyString(owner.taskId)) return false;
  if (owner.kind === 'cluster-agent') {
    return isNonEmptyString(owner.clusterId) && isNonEmptyString(owner.agentId);
  }
  return owner.clusterId === null && owner.agentId === null;
}

function validateSession(session) {
  if (!session || typeof session !== 'object') return false;
  return (
    isNonEmptyString(session.sessionId) &&
    isNonEmptyString(session.fileName) &&
    isIdentity(session.fileIdentity) &&
    isDigest(session.artifactManifestDigest) &&
    isDigest(session.executionFingerprint) &&
    isNonEmptyString(session.selectedProvider) &&
    isNonEmptyString(session.selectedModel)
  );
}

/**
 * Validate and canonicalize an arbitrary value as a closed `task.ompSessionOwnership` object.
 * Returns null on any structural violation — callers must fail closed to a fresh context rather
 * than partially trusting a malformed record.
 */
export function validateOmpSessionOwnership(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.schemaVersion !== OMP_OWNERSHIP_SCHEMA_VERSION) return null;
  if (!STATES.has(value.state)) return null;
  if (!isNonEmptyString(value.partitionId)) return null;
  if (!isNonEmptyString(value.storageRoot)) return null;
  if (!isNonEmptyString(value.partitionPath)) return null;
  if (!isDecimalString(value.ownerUid)) return null;
  if (!isIdentity(value.storageRootIdentity)) return null;
  if (!isNonEmptyString(value.canonicalWorkspace)) return null;
  if (!validateOwner(value.owner)) return null;

  if (value.state === 'committed') {
    if (!isIdentity(value.partitionIdentity)) return null;
    if (!validateSession(value.session)) return null;
  } else if (value.partitionIdentity !== null || value.session !== null) {
    // provisional / cleanup-required: null unless a *fully* observed prior commit is being
    // downgraded, in which case both fields are still validated (never partially trusted).
    if (value.partitionIdentity !== null && !isIdentity(value.partitionIdentity)) return null;
    if (value.session !== null && !validateSession(value.session)) return null;
  }

  return {
    schemaVersion: OMP_OWNERSHIP_SCHEMA_VERSION,
    state: value.state,
    partitionId: value.partitionId,
    storageRoot: value.storageRoot,
    partitionPath: value.partitionPath,
    ownerUid: value.ownerUid,
    storageRootIdentity: {
      device: value.storageRootIdentity.device,
      inode: value.storageRootIdentity.inode,
    },
    partitionIdentity: value.partitionIdentity
      ? { device: value.partitionIdentity.device, inode: value.partitionIdentity.inode }
      : null,
    canonicalWorkspace: value.canonicalWorkspace,
    owner: {
      kind: value.owner.kind,
      clusterId: value.owner.clusterId,
      agentId: value.owner.agentId,
      taskId: value.owner.taskId,
    },
    session: value.session
      ? {
          sessionId: value.session.sessionId,
          fileName: value.session.fileName,
          fileIdentity: {
            device: value.session.fileIdentity.device,
            inode: value.session.fileIdentity.inode,
          },
          artifactManifestDigest: value.session.artifactManifestDigest,
          executionFingerprint: value.session.executionFingerprint,
          selectedProvider: value.session.selectedProvider,
          selectedModel: value.session.selectedModel,
        }
      : null,
  };
}

/** Build the initial provisional ownership record. Pure — the directory need not exist yet. */
export function buildProvisionalOwnership({
  partitionId,
  storageRoot,
  partitionPath,
  storageRootIdentity,
  canonicalWorkspace,
  owner,
}) {
  const record = {
    schemaVersion: OMP_OWNERSHIP_SCHEMA_VERSION,
    state: 'provisional',
    partitionId,
    storageRoot: resolvePath(storageRoot),
    partitionPath: resolvePath(partitionPath),
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

export function serializeOmpSessionOwnership(value) {
  if (!value) return null;
  const validated = validateOmpSessionOwnership(value);
  if (!validated) {
    throw new Error('Refusing to persist an invalid ompSessionOwnership record.');
  }
  return JSON.stringify(validated);
}
