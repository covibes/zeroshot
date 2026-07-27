const { normalizeProviderName, providerSupportsCapability } = require('../../lib/provider-names');

function normalizeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  const sessionId = normalizeSessionId(value.sessionId);
  if (!provider || !sessionId || !supportsSessionResume(provider)) {
    return null;
  }
  return { provider, sessionId };
}

function agentCanReuseSession(agent, providerName) {
  return !agent?.isolation?.enabled && supportsSessionResume(providerName);
}

function resolveAgentResumeSessionId(agent, providerName) {
  const provider = normalizeProviderName(providerName);
  const stored = normalizeProviderSession(agent?.providerSession);
  if (!agentCanReuseSession(agent, provider) || !stored || stored.provider !== provider) {
    if (agent && stored) {
      agent.providerSession = null;
    }
    return null;
  }
  return stored.sessionId;
}

function providerSessionFromCompletedTask({ agent, providerName, taskInfo }) {
  const provider = normalizeProviderName(providerName);
  if (!agentCanReuseSession(agent, provider)) {
    return null;
  }
  if (!taskInfo || taskInfo.status !== 'completed') {
    return null;
  }
  if (normalizeProviderName(taskInfo.provider) !== provider) {
    return null;
  }
  const sessionId = normalizeSessionId(taskInfo.sessionId);
  return sessionId ? { provider, sessionId } : null;
}

function updateAgentProviderSession(agent, value) {
  const session = normalizeProviderSession(value);
  agent.providerSession = session;
  return session;
}

module.exports = {
  normalizeProviderSession,
  providerSessionFromCompletedTask,
  resolveAgentResumeSessionId,
  supportsSessionResume,
  updateAgentProviderSession,
};
