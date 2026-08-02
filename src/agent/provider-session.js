const crypto = require('crypto');
const path = require('path');

const { normalizeProviderName, providerSupportsCapability } = require('../../lib/provider-names');
const { tryCanonicalMessageSequence } = require('../ledger-sequence');
const { validateOwnedByTask } = require('../../task-lib/omp-session-ownership-schema.js');

const DURABLE_SESSION_BOUNDARY_EVENTS = new Set([
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'RETRY_SCHEDULED',
  'AGENT_RESTART_ATTEMPT',
]);
const RESTORABLE_AGENT_STATES = new Set(['idle', 'stopped', 'completed']);

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAbsolutePath(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? path.resolve(normalized) : null;
}

function normalizeCursor(value) {
  return tryCanonicalMessageSequence(value);
}

function normalizeNullableCursor(value) {
  return value === null ? null : normalizeCursor(value);
}

function normalizePromptIdentity(value) {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function promptIdentity(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

const DECIMAL_STRING = /^(0|[1-9][0-9]*)$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SESSION_FILE_NAME = /^[^/\\]+\.jsonl$/;
const { PARTITION_ID_PATTERN } = require('../omp-session-partition');

// Exactly the field set issue #866 fixes for this snapshot — no more, no less. The record is
// closed in both directions so a stale snapshot written by a different Zeroshot version, or one
// carrying smuggled extra state, is rejected rather than partially trusted.
const OMP_SESSION_KEYS = new Set([
  'schemaVersion',
  'partitionId',
  'sessionFileName',
  'sessionFileIdentity',
  'artifactManifestDigest',
  'executionFingerprint',
  'selectedProvider',
  'selectedModel',
]);
const IDENTITY_KEYS = new Set(['device', 'inode']);

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Object.keys(value).every((key) => IDENTITY_KEYS.has(key))) return null;
  if (!DECIMAL_STRING.test(String(value.device)) || !DECIMAL_STRING.test(String(value.inode))) {
    return null;
  }
  return { device: String(value.device), inode: String(value.inode) };
}

/**
 * The optional providerSession.ompSession field (issue #866): required in addition to the
 * generic tuple above for provider 'omp', absent for every other provider. Every digest here is
 * sha256:<64-lower-hex>; every device/inode is a canonical unsigned decimal string. Never carries
 * storage-root or partition paths — those stay in task.ompSessionOwnership, not the agent
 * snapshot; the partition is re-derived from the owner row at resume time.
 */
function normalizeOmpSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (!Object.keys(value).every((key) => OMP_SESSION_KEYS.has(key))) return null;
  const sessionFileIdentity = normalizeIdentity(value.sessionFileIdentity);
  if (
    value.schemaVersion !== 1 ||
    !normalizeNonEmptyString(value.partitionId) ||
    !PARTITION_ID_PATTERN.test(value.partitionId) ||
    !normalizeNonEmptyString(value.sessionFileName) ||
    !SESSION_FILE_NAME.test(value.sessionFileName) ||
    value.sessionFileName === '.jsonl' ||
    !sessionFileIdentity ||
    typeof value.artifactManifestDigest !== 'string' ||
    !SHA256_DIGEST.test(value.artifactManifestDigest) ||
    typeof value.executionFingerprint !== 'string' ||
    !SHA256_DIGEST.test(value.executionFingerprint) ||
    !normalizeNonEmptyString(value.selectedProvider) ||
    !normalizeNonEmptyString(value.selectedModel)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    partitionId: value.partitionId,
    sessionFileName: value.sessionFileName,
    sessionFileIdentity,
    artifactManifestDigest: value.artifactManifestDigest,
    executionFingerprint: value.executionFingerprint,
    selectedProvider: value.selectedProvider,
    selectedModel: value.selectedModel,
  };
}

function supportsSessionResume(providerName) {
  try {
    return providerSupportsCapability(providerName, 'sessionResume');
  } catch {
    return false;
  }
}

function normalizeProviderSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const provider = normalizeProviderName(value.provider);
  const sessionId = normalizeNonEmptyString(value.sessionId);
  const agentId = normalizeNonEmptyString(value.agentId);
  const taskId = normalizeNonEmptyString(value.taskId);
  const generation = value.generation;
  const cwd = normalizeAbsolutePath(value.cwd);
  const worktreePath =
    value.worktreePath === null ? null : normalizeAbsolutePath(value.worktreePath);
  const contextSequence = normalizeCursor(value.contextSequence);
  const guidanceSequence = normalizeNullableCursor(value.guidanceSequence);
  const normalizedPromptIdentity = normalizePromptIdentity(value.promptIdentity);
  const hasOmpSession = Object.hasOwn(value, 'ompSession');
  const normalizedOmpSession = hasOmpSession ? normalizeOmpSession(value.ompSession) : null;

  if (
    !provider ||
    !sessionId ||
    !agentId ||
    !taskId ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    !cwd ||
    !Object.hasOwn(value, 'worktreePath') ||
    (value.worktreePath !== null && !worktreePath) ||
    contextSequence === null ||
    !Object.hasOwn(value, 'guidanceSequence') ||
    (value.guidanceSequence !== null && guidanceSequence === null) ||
    !Object.hasOwn(value, 'promptIdentity') ||
    normalizedPromptIdentity === undefined ||
    !supportsSessionResume(provider) ||
    (provider === 'omp' ? normalizedOmpSession === null : hasOmpSession)
  ) {
    return null;
  }

  return {
    provider,
    sessionId,
    agentId,
    taskId,
    generation,
    cwd,
    worktreePath,
    contextSequence,
    guidanceSequence,
    promptIdentity: normalizedPromptIdentity,
    ...(provider === 'omp' ? { ompSession: normalizedOmpSession } : {}),
  };
}

function agentWorkspaceProvenance(agent) {
  const worktreePath = agent?.worktree?.enabled ? normalizeAbsolutePath(agent.worktree.path) : null;
  const cwd = normalizeAbsolutePath(agent?.config?.cwd || worktreePath || process.cwd());
  return { cwd, worktreePath };
}

function agentCanReuseSession(agent, providerName) {
  return !agent?.isolation?.enabled && supportsSessionResume(providerName);
}

function sessionMatchesAgent(session, agent, providerName, expectedGeneration) {
  const provider = normalizeProviderName(providerName);
  const workspace = agentWorkspaceProvenance(agent);
  return (
    agentCanReuseSession(agent, provider) &&
    session.provider === provider &&
    session.agentId === agent?.id &&
    session.generation === expectedGeneration &&
    session.cwd === workspace.cwd &&
    session.worktreePath === workspace.worktreePath
  );
}

function resolveAgentProviderSession(agent, providerName) {
  const stored = normalizeProviderSession(agent?.providerSession);
  const expectedGeneration = Number.isInteger(agent?.iteration) ? agent.iteration - 1 : -1;

  if (!stored || !sessionMatchesAgent(stored, agent, providerName, expectedGeneration)) {
    if (agent) {
      if (agent.providerSession) {
        agent.lastGuidanceAppliedId = null;
      }
      agent.providerSession = null;
    }
    return null;
  }

  return stored;
}

function resolveAgentResumeSessionId(agent, providerName) {
  return resolveAgentProviderSession(agent, providerName)?.sessionId || null;
}

function validateCompletedResumeIdentity(taskInfo) {
  const requestedSessionId = normalizeNonEmptyString(taskInfo?.requestedResumeSessionId);
  if (!requestedSessionId) {
    return null;
  }
  if (taskInfo?.resumeIdentityVerified !== true) {
    return 'Provider continuation identity was not durably verified';
  }
  if (taskInfo?.sessionIdConflict === true) {
    return 'Provider continuation emitted conflicting session identities';
  }

  const capturedSessionId = normalizeNonEmptyString(taskInfo?.sessionId);
  if (capturedSessionId === requestedSessionId) {
    return null;
  }

  return capturedSessionId
    ? 'Provider continuation returned a different session identity'
    : 'Provider continuation did not confirm the requested session identity';
}

/** taskInfo.ompSessionOwnership is the authoritative, watcher-committed continuation evidence for
 * provider 'omp'; a provisional/cleanup-required/missing record means this task never durably
 * proved a resumable session, regardless of what the generic sessionId/resumeIdentityVerified
 * columns say (rpc-watcher.js never populates those — they're the stdout-parsing watchers' path).
 * The record is re-fenced to this exact task row: an ownership object naming a different owner is
 * not this task's continuation evidence, however well-formed it is. */
function ompSessionFromCompletedTask(taskInfo) {
  const ownership = validateOwnedByTask(taskInfo?.ompSessionOwnership ?? null, taskInfo?.id);
  if (!ownership || ownership.state !== 'committed' || !ownership.session) {
    return null;
  }
  return {
    schemaVersion: 1,
    partitionId: ownership.partitionId,
    sessionFileName: ownership.session.fileName,
    sessionFileIdentity: ownership.session.fileIdentity,
    artifactManifestDigest: ownership.session.artifactManifestDigest,
    executionFingerprint: ownership.session.executionFingerprint,
    selectedProvider: ownership.session.selectedProvider,
    selectedModel: ownership.session.selectedModel,
  };
}

function providerSessionFromCompletedTask({
  agent,
  providerName,
  taskInfo,
  logicalSuccess = true,
}) {
  const provider = normalizeProviderName(providerName);
  if (!logicalSuccess || !agentCanReuseSession(agent, provider)) {
    return null;
  }
  if (!taskInfo || taskInfo.status !== 'completed') {
    return null;
  }
  if (normalizeProviderName(taskInfo.provider) !== provider) {
    return null;
  }
  if (taskInfo.sessionIdConflict === true) {
    return null;
  }
  if (validateCompletedResumeIdentity(taskInfo)) {
    return null;
  }

  const isOmp = provider === 'omp';
  const ompOwnership = isOmp
    ? validateOwnedByTask(taskInfo.ompSessionOwnership ?? null, taskInfo.id)
    : null;
  const ompSession = isOmp ? ompSessionFromCompletedTask(taskInfo) : null;
  // rpc-watcher.js never populates the generic sessionId column; the OMP-observed session ID
  // committed alongside ompSession is the one authoritative identity for this provider.
  const sessionId = isOmp
    ? normalizeNonEmptyString(ompOwnership?.state === 'committed' ? ompOwnership.session?.sessionId : null)
    : normalizeNonEmptyString(taskInfo.sessionId);
  const taskId = normalizeNonEmptyString(taskInfo.id);
  const generation = agent?.iteration;
  const agentId = normalizeNonEmptyString(agent?.id);
  const workspace = agentWorkspaceProvenance(agent);
  return normalizeProviderSession({
    provider,
    sessionId,
    agentId,
    taskId,
    generation,
    ...workspace,
    contextSequence: agent?.currentContextSequence,
    guidanceSequence: agent?.currentGuidanceSequence ?? null,
    promptIdentity: agent?.currentPromptIdentity ?? null,
    ...(isOmp ? { ompSession } : {}),
  });
}

function updateAgentProviderSession(agent, value) {
  if (agent.providerSession && value === null) {
    agent.lastGuidanceAppliedId = null;
  }
  const session = normalizeProviderSession(value);
  agent.providerSession = session;
  return session;
}

function readLastDurableSessionBoundary(messageBus, clusterId, agentId) {
  const lifecycle = messageBus.query({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: agentId,
    afterId: '0',
  });
  return lifecycle
    .filter((message) => DURABLE_SESSION_BOUNDARY_EVENTS.has(message.content?.data?.event))
    .at(-1);
}

function restoreAgentProviderSession({ agent, savedState, messageBus, clusterId }) {
  const session = normalizeProviderSession(savedState?.providerSession);
  if (!session || !RESTORABLE_AGENT_STATES.has(savedState?.state)) {
    return null;
  }
  if (
    !Object.hasOwn(savedState, 'lastGuidanceAppliedId') ||
    normalizeNullableCursor(savedState.lastGuidanceAppliedId) !== session.guidanceSequence
  ) {
    return null;
  }
  if (!sessionMatchesAgent(session, agent, session.provider, savedState.iteration)) {
    return null;
  }

  const boundary = readLastDurableSessionBoundary(messageBus, clusterId, agent.id);
  const data = boundary?.content?.data;
  if (
    data?.event !== 'TASK_COMPLETED' ||
    data.taskId !== session.taskId ||
    data.iteration !== session.generation ||
    normalizeProviderName(data.provider) !== session.provider ||
    normalizeCursor(data.contextSequence) !== session.contextSequence ||
    normalizeNullableCursor(data.guidanceSequence) !== session.guidanceSequence ||
    data.promptIdentity !== session.promptIdentity
  ) {
    return null;
  }

  return session;
}

module.exports = {
  agentWorkspaceProvenance,
  normalizeProviderSession,
  promptIdentity,
  providerSessionFromCompletedTask,
  resolveAgentProviderSession,
  resolveAgentResumeSessionId,
  restoreAgentProviderSession,
  supportsSessionResume,
  updateAgentProviderSession,
  validateCompletedResumeIdentity,
};
