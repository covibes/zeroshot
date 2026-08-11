// @ts-nocheck

const { parseProviderEvent, providerFailureFields } = require('./provider-control-plane');

const ZEROSHOT_PI_METADATA_PREFIXES = [
  '[ZEROSHOT] Earlier provider output omitted',
  '[ZEROSHOT][PROVIDER_STDERR] ',
  '[ZEROSHOT][FATAL] ',
];
const ZEROSHOT_RETAINED_RECORD_PREFIX = '[ZEROSHOT] Provider output record retained';
const PI_STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const PI_REQUIRED_TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const PI_OPTIONAL_TOKEN_FIELDS = ['cacheWrite1h', 'reasoning'];
const PI_TOKEN_FIELDS = [...PI_REQUIRED_TOKEN_FIELDS, ...PI_OPTIONAL_TOKEN_FIELDS];
const PI_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
const PI_PENDING_EVENT_TYPES = new Set([
  'turn_end',
  'agent_end',
  'auto_retry_start',
  'auto_retry_end',
]);

function pendingFailureMetadata(failure) {
  return {
    zeroshot_pending_failure: {
      provider: failure.provider,
      category: failure.category,
      kind: failure.classification.kind,
      retryable: failure.classification.retryable,
      diagnostic: failure.diagnostic,
    },
  };
}

function numericFields(fields, source) {
  return Object.fromEntries(
    fields.map((field) => [field, typeof source[field] === 'number' ? source[field] : 0])
  );
}

function redactedUsage(usage) {
  const value = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  return {
    ...numericFields(PI_REQUIRED_TOKEN_FIELDS, value),
    ...(typeof value.cacheWrite1h === 'number' ? { cacheWrite1h: value.cacheWrite1h } : {}),
    ...(typeof value.reasoning === 'number' ? { reasoning: value.reasoning } : {}),
    cost: numericFields(PI_COST_FIELDS, isRecord(value.cost) ? value.cost : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasNumericFields(value, fields) {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'number');
}

function addNumericFields(target, source, fields) {
  for (const field of fields) {
    if (typeof source[field] === 'number') target[field] = (target[field] || 0) + source[field];
  }
}

function rememberTokenUsage(state, usage) {
  if (!hasNumericFields(usage, PI_REQUIRED_TOKEN_FIELDS)) return false;
  if (!hasNumericFields(usage.cost, PI_COST_FIELDS)) return false;
  if (
    !PI_OPTIONAL_TOKEN_FIELDS.every(
      (field) => usage[field] === undefined || typeof usage[field] === 'number'
    )
  ) {
    return false;
  }
  state.piUsage = state.piUsage || { tokens: {}, cost: {} };
  addNumericFields(state.piUsage.tokens, usage, PI_TOKEN_FIELDS);
  addNumericFields(state.piUsage.cost, usage.cost, PI_COST_FIELDS);
  return true;
}

function getPiTokenUsage(state) {
  if (!state?.piUsage) return null;
  const { tokens, cost } = state.piUsage;
  return {
    inputTokens: tokens.input || 0,
    outputTokens: tokens.output || 0,
    cacheReadInputTokens: tokens.cacheRead || 0,
    cacheCreationInputTokens: tokens.cacheWrite || 0,
    totalCostUsd: cost.total || 0,
    durationMs: null,
    modelUsage: { ...tokens, cost: { ...cost } },
  };
}

function isValidAssistantMessage(message) {
  return Array.isArray(message?.content) && PI_STOP_REASONS.has(message.stopReason);
}

function redactPendingFailure(failure, parsed) {
  const pending = pendingFailureMetadata(failure);
  if (parsed.type === 'agent_end') {
    return JSON.stringify({
      type: parsed.type,
      messages: [],
      willRetry: parsed.willRetry === true,
      ...pending,
    });
  }
  if (parsed.type === 'auto_retry_end') {
    return JSON.stringify({ type: parsed.type, success: false, ...pending });
  }
  if (parsed.type === 'auto_retry_start') {
    return JSON.stringify({
      type: parsed.type,
      ...numericFields(
        ['attempt', 'maxAttempts', 'delayMs'].filter((field) => typeof parsed[field] === 'number'),
        parsed
      ),
      ...pending,
    });
  }
  return JSON.stringify({
    type: parsed.type,
    message: {
      role: 'assistant',
      content: [],
      usage: redactedUsage(parsed.message?.usage),
      stopReason: 'error',
      errorMessage: 'Pi provider turn failed; awaiting agent settlement.',
    },
    ...(parsed.type === 'turn_end' ? { toolResults: [] } : {}),
    ...pending,
  });
}

function finalFailureEnvelope(failure) {
  return JSON.stringify({
    type: 'agent_settled',
    ...providerFailureFields(failure),
  });
}

function rememberProtocolFailure(state, content, extractProviderFailure) {
  const failure = extractProviderFailure(content, 'pi');
  if (failure) {
    state.piProtocolFailure = failure;
    state.providerFailure = failure;
  }
  return failure;
}

function failProtocolLine(state, content, extractProviderFailure) {
  const failure = rememberProtocolFailure(state, content, extractProviderFailure);
  return failure ? finalFailureEnvelope(failure) : content;
}

function handleMessageEnd(state, content, parsed, extractProviderFailure) {
  const role = parsed.message?.role;
  if (typeof role !== 'string') return failProtocolLine(state, content, extractProviderFailure);
  const hasCountedUsage = role === 'assistant' || parsed.message?.usage !== undefined;
  if (
    ['assistant', 'toolResult'].includes(role) &&
    hasCountedUsage &&
    !rememberTokenUsage(state, parsed.message?.usage)
  ) {
    return failProtocolLine(state, 'invalid Pi usage', extractProviderFailure);
  }
  if (role !== 'assistant') return content;
  if (!isValidAssistantMessage(parsed.message)) {
    return failProtocolLine(state, content, extractProviderFailure);
  }
  const failure = extractProviderFailure(
    `${content}\n${JSON.stringify({ type: 'agent_settled' })}`,
    'pi'
  );
  state.piLatestAssistantObserved = true;
  state.pendingPiFailure = failure;
  if (failure) return redactPendingFailure(failure, parsed);
  if (!state.piProtocolFailure) state.providerFailure = null;
  return content;
}

function usageForEvent(parsed) {
  if (parsed.type === 'compaction_end' && parsed.result?.usage !== undefined) {
    return parsed.result.usage;
  }
  if (
    parsed.type === 'entry_appended' &&
    parsed.entry?.type === 'branch_summary' &&
    parsed.entry.usage !== undefined
  ) {
    return parsed.entry.usage;
  }
  return undefined;
}

function handleSettlement(state, content, extractProviderFailure) {
  state.piProtocolSettled = true;
  const missingAssistantFailure = state.piLatestAssistantObserved
    ? null
    : extractProviderFailure(JSON.stringify({ type: 'agent_settled' }), 'pi');
  const failure = state.piProtocolFailure || state.pendingPiFailure || missingAssistantFailure;
  state.pendingPiFailure = null;
  state.providerFailure = failure || null;
  return failure ? finalFailureEnvelope(failure) : content;
}

function redactPiFailureForControlPlane(state, content, extractProviderFailure) {
  if (content.startsWith(ZEROSHOT_RETAINED_RECORD_PREFIX)) {
    state.piProtocolPrefixOmitted = true;
    return content;
  }
  if (ZEROSHOT_PI_METADATA_PREFIXES.some((prefix) => content.startsWith(prefix))) return content;
  const parsed = parseProviderEvent(content);
  if (parsed === null || typeof parsed.type !== 'string') {
    return failProtocolLine(state, content, extractProviderFailure);
  }
  if (state.piProtocolSettled) {
    return failProtocolLine(
      state,
      `${JSON.stringify({ type: 'agent_settled' })}\n${content}`,
      extractProviderFailure
    );
  }
  state.piProtocolObserved = true;

  if (parsed.type === 'message_end') {
    return handleMessageEnd(state, content, parsed, extractProviderFailure);
  }
  const usage = usageForEvent(parsed);
  if (usage !== undefined && !rememberTokenUsage(state, usage)) {
    return failProtocolLine(state, 'invalid Pi usage', extractProviderFailure);
  }
  if (state.pendingPiFailure && PI_PENDING_EVENT_TYPES.has(parsed.type)) {
    return redactPendingFailure(state.pendingPiFailure, parsed);
  }
  return parsed.type === 'agent_settled'
    ? handleSettlement(state, content, extractProviderFailure)
    : content;
}

module.exports = { getPiTokenUsage, redactPiFailureForControlPlane };
