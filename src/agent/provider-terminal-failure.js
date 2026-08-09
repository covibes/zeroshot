// @ts-nocheck

const { getProvider } = require('../providers');
const { isCriticalAgent } = require('./critical-agent-policy');
const { extractCliFailure } = require('./output-extraction');

function categoryForProviderFailure(error, classification) {
  const isPermanent = classification.retryable === false;
  const authenticationPattern =
    /(?:invalid[_ -]?api[_ -]?key|api[_ -]?key.*invalid|unauthori[sz]ed|forbidden|authentication|permission denied)/i;
  if (isPermanent && authenticationPattern.test(error)) return 'authentication';

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

function extractProviderFailure(output, providerName) {
  const cliError = extractCliFailure(output, providerName);
  if (!cliError) return null;

  const classification = classifyProviderFailure(providerName, cliError.error);
  const category = categoryForProviderFailure(cliError.error, classification);
  return {
    error: `Provider ${cliError.provider} failed (${category}; ${classification.kind})`,
    provider: cliError.provider,
    event: cliError.provider === 'codex' ? 'turn.failed' : 'terminal_error',
    category,
    classification,
    diagnostic: cliError.diagnostic,
  };
}

function redactTerminalFailureForControlPlane(state, providerName, content) {
  const failure = extractProviderFailure(content, providerName);
  if (!failure) return content;

  state.providerFailure = failure;
  let eventType = 'provider.failure';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.type === 'string') eventType = parsed.type;
  } catch {
    // extractProviderFailure already proved a supported terminal envelope.
  }
  return JSON.stringify({
    type: eventType,
    ...(providerName === 'claude' ? { is_error: true } : {}),
    ...(providerName === 'gemini' ? { status: 'error', severity: 'error' } : {}),
    error: { message: failure.error },
    zeroshot_failure: {
      provider: failure.provider,
      event: failure.event,
      category: failure.category,
      kind: failure.classification.kind,
      retryable: failure.classification.retryable,
      diagnostic: failure.diagnostic,
    },
  });
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
  extractProviderFailure,
  publishCriticalFailure,
  receiptFields,
  redactTerminalFailureForControlPlane,
  workerFailure,
};
