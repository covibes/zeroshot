import criticalAgentPolicy = require('./critical-agent-policy');
import piTerminalLifecycle = require('./pi-terminal-lifecycle');
import providerControlPlane = require('./provider-control-plane');
import type { PiLifecycleState, ProviderFailure } from './pi-terminal-lifecycle-types';
import type { FailureOutputExtractionBoundary as OutputExtractionBoundary } from './output-extraction-types';
import type {
  FailureMetadata,
  ProviderClassification,
  ProvidersBoundary,
  TerminalFailureArguments,
  TerminalFailureError,
  WorkerFailure,
} from './provider-terminal-failure-types';

const { isCriticalAgent } = criticalAgentPolicy;
const { getPiTokenUsage, redactPiFailureForControlPlane } = piTerminalLifecycle;
const { parseProviderEvent, providerFailureFields } = providerControlPlane;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProvidersBoundary(value: unknown): value is ProvidersBoundary {
  return isRecord(value) && typeof value.getProvider === 'function';
}

function isOutputExtractionBoundary(value: unknown): value is OutputExtractionBoundary {
  return isRecord(value) && typeof value.extractCliFailure === 'function';
}

const rawProviders: unknown = require('../providers');
if (!isProvidersBoundary(rawProviders)) {
  throw new TypeError('providers module must expose getProvider');
}
const { getProvider } = rawProviders;

const rawOutputExtraction: unknown = require('./output-extraction');
if (!isOutputExtractionBoundary(rawOutputExtraction)) {
  throw new TypeError('output-extraction module must expose extractCliFailure');
}
const { extractCliFailure } = rawOutputExtraction;

const AUTHENTICATION_FAILURE_PATTERNS = [
  /invalid[_ -]?api[_ -]?key/i,
  /api[_ -]?key.*invalid/i,
  /(?:missing|no) api key/i,
  /run\s*\/login/i,
  /unauthori[sz]ed/i,
  /forbidden|authentication|permission denied/i,
];

function categoryForProviderFailure(error: string, classification: ProviderClassification): string {
  const isPermanent = classification.retryable === false;
  if (isPermanent && AUTHENTICATION_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) {
    return 'authentication';
  }

  const quotaPattern = /(?:insufficient[_ -]?quota|quota exceeded|resource_exhausted)/i;
  if (isPermanent && quotaPattern.test(error)) return 'quota';
  if (isPermanent) return 'permanent';
  return classification.kind === 'unknown-retryable' ? 'unknown' : 'transient';
}

function normalizeClassification(value: unknown): ProviderClassification {
  if (!isRecord(value)) return { retryable: true, kind: 'unknown-retryable' };
  return {
    retryable: value.retryable !== false,
    kind: typeof value.kind === 'string' ? value.kind : 'unknown-retryable',
  };
}

function classifyProviderFailure(providerName: string, error: string): ProviderClassification {
  let rawClassification: unknown = { retryable: true, kind: 'unknown-retryable' };
  try {
    rawClassification = getProvider(providerName).adapter.classifyError(new Error(error));
  } catch {
    // Extraction remains available if a provider adapter cannot be loaded.
  }
  return normalizeClassification(rawClassification);
}

function providerFailureEvent(providerName: string): string {
  if (providerName === 'codex') return 'turn.failed';
  if (providerName === 'pi') return 'agent_settled';
  return 'terminal_error';
}

function extractProviderFailure(output: string, providerName: string): ProviderFailure | null {
  const cliError = extractCliFailure(output, providerName);
  if (!cliError) return null;

  const classification =
    cliError.providerClassification ?? classifyProviderFailure(providerName, cliError.error);
  const category =
    cliError.providerCategory ?? categoryForProviderFailure(cliError.error, classification);
  return {
    error: `Provider ${cliError.provider} failed (${category}; ${classification.kind})`,
    provider: cliError.provider,
    event: providerFailureEvent(cliError.provider),
    category,
    classification,
    diagnostic: cliError.diagnostic,
  };
}

function extractProviderCompletionFailure(
  output: string,
  providerName: string,
  state: PiLifecycleState = {}
): ProviderFailure | null {
  if (providerName !== 'pi') return extractProviderFailure(output, providerName);
  if (state.providerFailure) return state.providerFailure;
  if (state.piProtocolPrefixOmitted) return extractProviderFailure('', 'pi');
  if (!state.piProtocolObserved) return extractProviderFailure(output, 'pi');
  if (!state.piProtocolSettled || !state.piLatestAssistantObserved) {
    return extractProviderFailure('', 'pi');
  }
  return null;
}

function redactedFailureEnvelope(
  failure: ProviderFailure,
  providerName: string,
  eventType: string
): string {
  return JSON.stringify({
    type: eventType,
    ...(providerName === 'claude' ? { is_error: true } : {}),
    ...(providerName === 'gemini' ? { status: 'error', severity: 'error' } : {}),
    ...providerFailureFields(failure),
  });
}

function redactTerminalFailureForControlPlane(
  state: PiLifecycleState,
  providerName: string,
  content: string
): string {
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

function decorateError<T extends TerminalFailureError>(
  error: T,
  failure: ProviderFailure | null | undefined
): T {
  if (!failure) return error;
  error.provider = failure.provider || null;
  error.providerEvent = failure.event || null;
  error.providerCategory = failure.category || null;
  error.classification = failure.classification || null;
  error.providerDiagnostic = failure.diagnostic || null;
  if (failure.classification?.retryable === false) error.permanent = true;
  return error;
}

function receiptFields(error: FailureMetadata | null | undefined): Record<string, unknown> {
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

function workerFailure(error: FailureMetadata | null | undefined): WorkerFailure {
  const authenticationFailure =
    error?.provider &&
    error.classification?.retryable === false &&
    error.providerCategory === 'authentication';
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
}: TerminalFailureArguments): WorkerFailure {
  const specific =
    error.hookFailure ||
    structuredOutputInvalid ||
    unsupportedCapability ||
    error.vertexModelError ||
    error.terminationExhausted;
  const critical = isCriticalAgent(agent);
  if (!critical || specific) return worker;

  agent._publish({
    topic: 'CLUSTER_FAILED',
    receiver: 'broadcast',
    content: {
      text: `Critical agent ${agent.id} exhausted its retry budget`,
      data: {
        reason: error.provider ? 'provider_execution_failed' : 'critical_agent_exhausted',
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
}: TerminalFailureArguments): Record<string, unknown> {
  return {
    ...(error.terminationExhausted ? agent.cluster.failureInfo : {}),
    agentId: agent.id,
    taskId: error.taskId || agent.currentTaskId,
    iteration: agent.iteration,
    error: error.message,
    attempts,
    ...receiptFields(error),
    ...(error.provider ? { code: worker.code, workerReason: worker.reason } : {}),
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

export = {
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
