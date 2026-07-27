const crypto = require('crypto');
const path = require('path');

const { normalizeProviderName, providerSupportsCapability } = require('../../lib/provider-names');
const { tryCanonicalMessageSequence } = require('../ledger-sequence');

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
    !supportsSessionResume(provider)
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

  const sessionId = normalizeNonEmptyString(taskInfo.sessionId);
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
  });
}

function updateAgentProviderSession(agent, value) {
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
