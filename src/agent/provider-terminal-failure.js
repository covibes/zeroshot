// @ts-nocheck

const { getProvider } = require('../providers');
const { isCriticalAgent } = require('./critical-agent-policy');
const { extractCliFailure } = require('./output-extraction');
const { getPiTokenUsage, redactPiFailureForControlPlane } = require('./pi-terminal-lifecycle');
const { parseProviderEvent, providerFailureFields } = require('./provider-control-plane');

const AUTHENTICATION_FAILURE_PATTERNS = [
  /invalid[_ -]?api[_ -]?key/i,
  /api[_ -]?key.*invalid/i,
  /(?:missing|no) api key/i,
  /run\s*\/login/i,
  /unauthori[sz]ed/i,
  /forbidden|authentication|permission denied/i,
];

function categoryForProviderFailure(error, classification) {
  const isPermanent = classification.retryable === false;
  if (isPermanent && AUTHENTICATION_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) {
    return 'authentication';
  }

  const quotaPattern = /(?:insufficient[_ -]?quota|quota exceeded|resource_exhausted)/i;
  if (isPermanent && quotaPattern.test(error)) return 'quota';
  if (isPermanent) return 'permanent';
  return classification.kind === 'unknown-retryable' ? 'unknown' : 'transient';
}

function classifyProviderFailure(providerName, error) {
  let rawClassification = { retryable: true, kind: 'unknown-retryable' };
  try {
    rawClassification = getProvider(providerName).adapter.classifyError(new Error(error));
  } catch {
    // Extraction remains available if a provider adapter cannot be loaded.
  }
  return {
    retryable: rawClassification?.retryable !== false,
    kind:
      typeof rawClassification?.kind === 'string' ? rawClassification.kind : 'unknown-retryable',
  };
}

function providerFailureEvent(providerName) {
  if (providerName === 'codex') return 'turn.failed';
  if (providerName === 'pi') return 'agent_settled';
  return 'terminal_error';
}

function extractProviderFailure(output, providerName) {
  const cliError = extractCliFailure(output, providerName);
  if (!cliError) return null;

  const classification = classifyProviderFailure(providerName, cliError.error);
  const category = categoryForProviderFailure(cliError.error, classification);
  return {
    error: `Provider ${cliError.provider} failed (${category}; ${classification.kind})`,
    provider: cliError.provider,
    event: providerFailureEvent(cliError.provider),
    category,
    classification,
    diagnostic: cliError.diagnostic,
  };
}

function extractProviderCompletionFailure(output, providerName, state = {}) {
  if (providerName !== 'pi') return extractProviderFailure(output, providerName);
  if (state.providerFailure) return state.providerFailure;
  if (state.piProtocolPrefixOmitted) return extractProviderFailure('', 'pi');
  if (!state.piProtocolObserved) return extractProviderFailure(output, 'pi');
  if (!state.piProtocolSettled || !state.piLatestAssistantObserved) {
    return extractProviderFailure('', 'pi');
  }
  return null;
}

function redactedFailureEnvelope(failure, providerName, eventType) {
  return JSON.stringify({
    type: eventType,
    ...(providerName === 'claude' ? { is_error: true } : {}),
    ...(providerName === 'gemini' ? { status: 'error', severity: 'error' } : {}),
    ...providerFailureFields(failure),
  });
}

function redactTerminalFailureForControlPlane(state, providerName, content) {
  if (providerName === 'pi') {
    return redactPiFailureForControlPlane(state, content, extractProviderFailure);
  }

  const failure = extractProviderFailure(content, providerName);
  if (!failure) return content;

  state.providerFailure = failure;
  const parsed = parseProviderEvent(content);
  const eventType = typeof parsed?.type === 'string' ? parsed.type : 'provider.failure';
  return redactedFailureEnvelope(failure, providerName, eventType);
}

function decorateError(error, failure) {
  if (!failure) return error;
  error.provider = failure.provider || null;
  error.providerEvent = failure.event || null;
  error.providerCategory = failure.category || null;
  error.classification = failure.classification || null;
  error.providerDiagnostic = failure.diagnostic || null;
  if (failure.classification?.retryable === false) error.permanent = true;
  return error;
}

function receiptFields(error) {
  if (!error?.provider) return {};
  return {
    provider: error.provider,
    event: error.providerEvent,
    category: error.providerCategory,
    kind: error.classification?.kind,
    retryable: error.classification?.retryable,
    diagnostic: error.providerDiagnostic,
  };
}

function workerFailure(error) {
  const authenticationFailure =
    error?.provider &&
    error?.classification?.retryable === false &&
    error?.providerCategory === 'authentication';
  return authenticationFailure
    ? { code: 'refusal', reason: 'authentication_required' }
    : { code: 'crash', reason: 'declared_failure' };
}

function publishCriticalFailure({
  agent,
  error,
  attempts,
  worker,
  unsupportedCapability,
  structuredOutputInvalid,
}) {
  const specific =
    error?.hookFailure ||
    structuredOutputInvalid ||
    unsupportedCapability ||
    error?.vertexModelError ||
    error?.terminationExhausted;
  const critical = isCriticalAgent(agent);
  if (!critical || specific) return worker;

  agent._publish({
    topic: 'CLUSTER_FAILED',
    receiver: 'broadcast',
    content: {
      text: `Critical agent ${agent.id} exhausted its retry budget`,
      data: {
        reason: error?.provider ? 'provider_execution_failed' : 'critical_agent_exhausted',
        agentId: agent.id,
        role: agent.role,
        attempts,
        code: worker.code,
        workerReason: worker.reason,
        ...receiptFields(error),
      },
    },
  });
  return worker;
}

function buildFinalFailureInfo({
  agent,
  error,
  attempts,
  worker,
  unsupportedCapability,
  structuredOutputInvalid,
}) {
  return {
    ...(error?.terminationExhausted ? agent.cluster.failureInfo : {}),
    agentId: agent.id,
    taskId: error?.taskId || agent.currentTaskId,
    iteration: agent.iteration,
    error: error.message,
    attempts,
    ...receiptFields(error),
    ...(error?.provider ? { code: worker.code, workerReason: worker.reason } : {}),
    ...(unsupportedCapability
      ? {
          code: error.code,
          permanent: true,
          provider: error.provider,
          capability: error.capability,
        }
      : {}),
    ...(structuredOutputInvalid ? { code: error.code, details: error.details ?? null } : {}),
    timestamp: Date.now(),
  };
}

module.exports = {
  buildFinalFailureInfo,
  decorateError,
  extractProviderCompletionFailure,
  extractProviderFailure,
  getPiTokenUsage,
  publishCriticalFailure,
  receiptFields,
  redactTerminalFailureForControlPlane,
  workerFailure,
};
