const crypto = require('node:crypto');
const { VALID_PROVIDERS } = require('../lib/provider-names');

const RESULT_SCHEMA = 'zeroshot-benchmark-result/v1';
const TELEMETRY_SCHEMA = 'zeroshot-benchmark-telemetry/v1';
const EMPTY_DIAGNOSTIC = Object.freeze({
  byteLength: 0,
  sha256: crypto.createHash('sha256').update('').digest('hex'),
});
const TASK_FAILURE_REASONS = new Set(['max_iterations', 'structured_output_invalid']);
const PROVIDER_CODES = new Set(['crash', 'refusal']);
const PROVIDERS = new Set(VALID_PROVIDERS);
const PROVIDER_EVENTS = new Set(['terminal_error', 'turn.failed']);
const PROVIDER_CATEGORIES = new Set([
  'authentication',
  'permanent',
  'quota',
  'transient',
  'unknown',
]);
const PROVIDER_KINDS = new Set([
  'permanent-pattern',
  'rate-limit',
  'retryable-pattern',
  'status-permanent',
  'status-retryable',
  'code-retryable',
  'unknown-retryable',
]);
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'totalCostUsd',
  'count',
];

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireClosedText(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${label} is outside the closed result contract`);
  }
  return value;
}

function requireDiagnostic(value) {
  if (
    value &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    return { byteLength: value.byteLength, sha256: value.sha256 };
  }
  throw new Error('provider diagnostic is outside the closed result contract');
}

function terminalData(message) {
  return requireObject(requireObject(message.content, 'terminal content').data, 'terminal data');
}

function isExplicitTaskFailure(message, data) {
  if (message.sender === 'orchestrator' || !TASK_FAILURE_REASONS.has(data.reason)) return false;
  if (data.reason === 'max_iterations') return message.receiver === 'system';
  return message.receiver === 'broadcast' && data.code === 'STRUCTURED_OUTPUT_INVALID';
}

function classifyTerminal(message) {
  if (message.topic === 'CLUSTER_COMPLETE') {
    return {
      outcome: 'completed',
      terminalOwner: 'task',
      code: 'ok',
      kind: 'workflow_complete',
      retryable: false,
      diagnostic: { ...EMPTY_DIAGNOSTIC },
      provider: null,
      event: null,
      category: null,
    };
  }

  if (message.topic !== 'CLUSTER_FAILED') {
    throw new Error(`unsupported terminal topic: ${message.topic}`);
  }
  const data = terminalData(message);
  if (isExplicitTaskFailure(message, data)) {
    return {
      outcome: 'task_failure',
      terminalOwner: 'task',
      code: data.reason,
      kind: 'declared_failure',
      retryable: false,
      diagnostic: { ...EMPTY_DIAGNOSTIC },
      provider: null,
      event: null,
      category: null,
    };
  }
  if (data.reason === 'provider_execution_failed') {
    if (typeof data.retryable !== 'boolean') {
      throw new Error('provider retryable must be boolean');
    }
    return {
      outcome: 'provider_failure',
      terminalOwner: 'provider',
      code: requireClosedText(data.code, PROVIDER_CODES, 'provider code'),
      kind: requireClosedText(data.kind, PROVIDER_KINDS, 'provider kind'),
      retryable: data.retryable,
      diagnostic: requireDiagnostic(data.diagnostic),
      provider: requireClosedText(data.provider, PROVIDERS, 'provider'),
      event: requireClosedText(data.event, PROVIDER_EVENTS, 'provider event'),
      category: requireClosedText(data.category, PROVIDER_CATEGORIES, 'provider category'),
    };
  }
  return {
    outcome: 'engine_failure',
    terminalOwner: 'engine',
    code: 'engine_failed',
    kind: 'declared_failure',
    retryable: false,
    diagnostic: { ...EMPTY_DIAGNOSTIC },
    provider: null,
    event: null,
    category: null,
  };
}

function validateStoppedAgents(agents) {
  if (!Array.isArray(agents)) throw new Error('agents must be an array');
  for (const agent of agents) {
    const state = requireObject(agent, 'agent state');
    if (state.pid !== null && state.pid !== undefined) {
      throw new Error(`agent ${String(state.id)} still has a live process identity`);
    }
  }
}

function validateRunId(runId) {
  const parts = typeof runId === 'string' ? runId.split('-') : [];
  const valid =
    parts.length >= 2 &&
    parts.every(
      (part) => part.length > 0 && [...part].every((character) => /[a-z0-9]/.test(character))
    );
  if (!valid) {
    throw new Error('runId must be a canonical cluster id');
  }
}

function buildBenchmarkResult({ runId, terminalMessages, agents }) {
  validateRunId(runId);
  if (!Array.isArray(terminalMessages) || terminalMessages.length !== 1) {
    throw new Error('foreground run must have exactly one terminal event');
  }
  validateStoppedAgents(agents);
  return {
    schema: RESULT_SCHEMA,
    runId,
    ...classifyTerminal(terminalMessages[0]),
  };
}

function buildCancelledResult({ runId, agents }) {
  validateRunId(runId);
  validateStoppedAgents(agents);
  return {
    schema: RESULT_SCHEMA,
    runId,
    outcome: 'cancelled',
    terminalOwner: 'controller',
    code: 'cancelled',
    kind: 'controlled_cancellation',
    retryable: false,
    diagnostic: { ...EMPTY_DIAGNOSTIC },
    provider: null,
    event: null,
    category: null,
  };
}

function normalizeTokenEntry(value, label) {
  const source = requireObject(value, label);
  const entry = {};
  for (const field of TOKEN_FIELDS) {
    const amount = source[field] ?? 0;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label}.${field} must be a finite non-negative number`);
    }
    entry[field] = amount;
  }
  return entry;
}

function buildTelemetry(runId, snapshot) {
  validateRunId(runId);
  const source = requireObject(snapshot, 'telemetry snapshot');
  if (!Number.isSafeInteger(source.messageCount) || source.messageCount < 0) {
    throw new Error('telemetry messageCount must be a non-negative safe integer');
  }
  const roles = requireObject(source.tokensByRole, 'tokensByRole');
  const names = Object.keys(roles).sort();
  if (names.length > 64) throw new Error('telemetry role count exceeds 64');
  const tokensByRole = {};
  for (const name of names) {
    const validRoleName =
      name === '_total' ||
      (name.length <= 128 &&
        /^[a-zA-Z0-9]$/.test(name[0] || '') &&
        [...name].every((character) => /[a-zA-Z0-9_.-]/.test(character)));
    if (!validRoleName) {
      throw new Error('telemetry role name is invalid');
    }
    tokensByRole[name] = normalizeTokenEntry(roles[name], `tokensByRole.${name}`);
  }
  return { schema: TELEMETRY_SCHEMA, runId, messageCount: source.messageCount, tokensByRole };
}

module.exports = {
  RESULT_SCHEMA,
  TELEMETRY_SCHEMA,
  buildBenchmarkResult,
  buildCancelledResult,
  buildTelemetry,
};
