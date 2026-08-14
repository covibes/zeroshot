import type { OutputEvent } from './agent-provider-boundary';
import { normalizeUnknown, SemanticProjectionError } from './semantic-json';

const RESULT_OPTIONAL_KEYS = [
  'result',
  'error',
  'cost',
  'duration',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'modelUsage',
  'requests',
  'usageSource',
  'usageCompleteness',
  'invocation',
  'ompSdk',
] as const;

function canonicalToolEvent(event: OutputEvent): Record<string, unknown> | null {
  if (event.type === 'tool_call') {
    return {
      type: 'tool_call',
      toolName: event.toolName ?? null,
      toolId: event.toolId ?? null,
      input: normalizeUnknown(event.input),
    };
  }
  if (event.type !== 'tool_result') return null;
  return {
    type: 'tool_result',
    toolId: event.toolId ?? null,
    content: normalizeUnknown(event.content),
    isError: normalizeUnknown(event.isError),
  };
}

function canonicalResult(event: OutputEvent): Record<string, unknown> {
  if (event.type !== 'result' || typeof event.success !== 'boolean') {
    throw new SemanticProjectionError('event_invalid');
  }
  const normalized: Record<string, unknown> = { type: 'result', success: event.success };
  for (const key of RESULT_OPTIONAL_KEYS) {
    if (event[key] !== undefined) normalized[key] = normalizeUnknown(event[key]);
  }
  return normalized;
}

export function canonicalEvent(event: OutputEvent): Record<string, unknown> {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new SemanticProjectionError('event_invalid');
  }
  if (event.type === 'text' || event.type === 'thinking') {
    if (typeof event.text !== 'string') throw new SemanticProjectionError('event_invalid');
    return { type: event.type, text: normalizeUnknown(event.text) };
  }
  return canonicalToolEvent(event) ?? canonicalResult(event);
}
