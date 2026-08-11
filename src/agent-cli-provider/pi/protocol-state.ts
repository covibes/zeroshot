import { parseTurnEndResult } from '../assistant-stream';
import { getNumber, getRecord, getString } from '../json';
import type { ProviderParserState, ResultEvent } from '../types';

const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const REQUIRED_USAGE_FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'totalTokens',
] as const;
const OPTIONAL_USAGE_FIELDS = ['cacheWrite1h', 'reasoning'] as const;
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;

interface PiProtocolState {
  latestAssistant?: Record<string, unknown>;
  invalid?: string;
  usage: Record<string, number>;
  cost: Record<string, number>;
}

const protocolStates = new WeakMap<ProviderParserState, PiProtocolState>();

function protocolState(state: ProviderParserState): PiProtocolState {
  const current = protocolStates.get(state);
  if (current !== undefined) return current;
  const created = { usage: {}, cost: {} };
  protocolStates.set(state, created);
  return created;
}

export function invalidatePiStream(state: ProviderParserState, error: string): void {
  protocolState(state).invalid = error;
}

function validateUsage(usage: Record<string, unknown>, label: string): string | null {
  for (const field of REQUIRED_USAGE_FIELDS) {
    if (getNumber(usage, field) === null) return `${label}.${field} is missing.`;
  }
  for (const field of OPTIONAL_USAGE_FIELDS) {
    if (usage[field] !== undefined && getNumber(usage, field) === null) {
      return `${label}.${field} is invalid.`;
    }
  }
  const cost = getRecord(usage, 'cost');
  if (cost === null) return `${label}.cost is missing.`;
  for (const field of COST_FIELDS) {
    if (getNumber(cost, field) === null) return `${label}.cost.${field} is missing.`;
  }
  return null;
}

function validateAssistant(message: Record<string, unknown>): string | null {
  if (!Array.isArray(message.content)) return 'Pi assistant message content is missing.';
  const stopReason = getString(message, 'stopReason');
  if (stopReason === null || !STOP_REASONS.has(stopReason)) {
    return 'Pi assistant message stopReason is missing or unsupported.';
  }
  const usage = getRecord(message, 'usage');
  return usage === null
    ? 'Pi assistant message usage is missing.'
    : validateUsage(usage, 'Pi assistant usage');
}

function addNumbers(
  target: Record<string, number>,
  source: Record<string, unknown>,
  fields: readonly string[]
): void {
  for (const field of fields) {
    const value = getNumber(source, field);
    if (value !== null) target[field] = (target[field] ?? 0) + value;
  }
}

export function rememberPiAssistant(
  message: Record<string, unknown> | null,
  state: ProviderParserState
): void {
  if (message === null) return invalidatePiStream(state, 'Pi message_end was missing its message.');
  const role = getString(message, 'role');
  if (role === null) return invalidatePiStream(state, 'Pi message_end was missing its role.');
  if (role !== 'assistant') return;
  const error = validateAssistant(message);
  if (error !== null) return invalidatePiStream(state, error);
  const current = protocolState(state);
  current.latestAssistant = message;
  rememberPiUsage(getRecord(message, 'usage'), state, 'Pi assistant usage');
}

export function rememberPiUsage(
  usage: Record<string, unknown> | null,
  state: ProviderParserState,
  label: string
): void {
  if (usage === null) return invalidatePiStream(state, `${label} is invalid.`);
  const error = validateUsage(usage, label);
  if (error !== null) return invalidatePiStream(state, error);
  const current = protocolState(state);
  addNumbers(current.usage, usage, [...REQUIRED_USAGE_FIELDS, ...OPTIONAL_USAGE_FIELDS]);
  const cost = getRecord(usage, 'cost');
  if (cost !== null) addNumbers(current.cost, cost, COST_FIELDS);
}

function usageResult(
  current: PiProtocolState
): Pick<
  ResultEvent,
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheCreationInputTokens'
  | 'cost'
  | 'modelUsage'
> {
  const cost = Object.keys(current.cost).length === 0 ? null : current.cost;
  return {
    inputTokens: current.usage.input ?? 0,
    outputTokens: current.usage.output ?? 0,
    cacheReadInputTokens: current.usage.cacheRead ?? 0,
    cacheCreationInputTokens: current.usage.cacheWrite ?? 0,
    cost: cost?.total ?? null,
    modelUsage: { ...current.usage, ...(cost === null ? {} : { cost }) },
  };
}

function failedResult(error: string, current: PiProtocolState): ResultEvent {
  return {
    type: 'result',
    success: false,
    result: null,
    error,
    ...usageResult(current),
  };
}

export function settlePiStream(state: ProviderParserState): ResultEvent {
  const current = protocolState(state);
  if (current.invalid) {
    return failedResult(`Invalid Pi JSON stream: ${current.invalid}`, current);
  }
  if (!current.latestAssistant) {
    return failedResult('Pi settled without an assistant message_end.', current);
  }
  const parsedResult = parseTurnEndResult(
    { message: current.latestAssistant },
    { failureMessage: 'Pi turn failed' }
  );
  const result =
    getString(current.latestAssistant, 'stopReason') === 'deferred'
      ? {
          ...parsedResult,
          success: false,
          result: null,
          error: 'Pi turn deferred without completing.',
        }
      : parsedResult;
  return {
    ...result,
    ...usageResult(current),
  };
}
