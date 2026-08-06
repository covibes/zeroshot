import {
  getArray,
  getBoolean,
  getNumber,
  getOptionalString,
  getRecord,
  getString,
  isRecord,
} from './json';
import type { OutputEvent, ResultEvent } from './types';
export interface AssistantStreamState {
  lastAssistantText?: string | undefined;
  lastAssistantThinking?: string | undefined;
  lastToolId?: string | null | undefined;
}

export interface AssistantSnapshot {
  readonly text: string;
  readonly thinking: string;
}

export function assistantSnapshot(message: Record<string, unknown>): AssistantSnapshot {
  if (getString(message, 'role') !== 'assistant') return { text: '', thinking: '' };

  let text = '';
  let thinking = '';
  for (const item of getArray(message, 'content')) {
    if (!isRecord(item)) continue;
    const type = getString(item, 'type');
    if (type === 'text') text += getString(item, 'text') ?? '';
    else if (type === 'thinking') thinking += getString(item, 'thinking') ?? '';
  }
  return { text, thinking };
}

export function snapshotDelta(previous: string, current: string): string | null {
  if (!current || previous === current) return null;
  if (current.startsWith(previous)) return current.slice(previous.length) || null;
  return current;
}

export function resetAssistantSnapshot(
  message: Record<string, unknown> | null,
  state: AssistantStreamState
): void {
  if (message !== null && getString(message, 'role') === 'assistant') {
    state.lastAssistantText = '';
    state.lastAssistantThinking = '';
  }
}

export function parseAssistantDelta(
  event: Record<string, unknown>,
  state: AssistantStreamState
): OutputEvent | null {
  const type = getString(event, 'type');
  const delta = getString(event, 'delta');
  if (!delta) return null;
  if (type === 'text_delta') {
    state.lastAssistantText = (state.lastAssistantText ?? '') + delta;
    return { type: 'text', text: delta };
  }
  if (type === 'thinking_delta') {
    state.lastAssistantThinking = (state.lastAssistantThinking ?? '') + delta;
    return { type: 'thinking', text: delta };
  }
  return null;
}

export interface AssistantSnapshotOptions {
  readonly retainPreviousOnEmpty?: boolean;
}

export function emitAssistantSnapshot(
  message: Record<string, unknown>,
  state: AssistantStreamState,
  options: AssistantSnapshotOptions = {}
): readonly OutputEvent[] {
  const snapshot = assistantSnapshot(message);
  const events: OutputEvent[] = [];
  const textDelta = snapshotDelta(state.lastAssistantText ?? '', snapshot.text);
  if (textDelta) events.push({ type: 'text', text: textDelta });
  if (!options.retainPreviousOnEmpty || snapshot.text) state.lastAssistantText = snapshot.text;
  const thinkingDelta = snapshotDelta(state.lastAssistantThinking ?? '', snapshot.thinking);
  if (thinkingDelta) events.push({ type: 'thinking', text: thinkingDelta });
  if (!options.retainPreviousOnEmpty || snapshot.thinking) {
    state.lastAssistantThinking = snapshot.thinking;
  }
  return events;
}

export function parseToolExecutionStart(
  event: Record<string, unknown>,
  state: AssistantStreamState
): OutputEvent {
  const toolId = getOptionalString(event, 'toolCallId');
  state.lastToolId = toolId;
  return {
    type: 'tool_call',
    toolName: getOptionalString(event, 'toolName'),
    toolId,
    input: event.args ?? {},
  };
}

export function parseToolExecutionUpdate(
  event: Record<string, unknown>,
  state: AssistantStreamState
): OutputEvent | null {
  const toolId = getOptionalString(event, 'toolCallId') ?? state.lastToolId;
  if (toolId !== undefined) state.lastToolId = toolId;
  if (!Object.prototype.hasOwnProperty.call(event, 'partialResult')) return null;
  return { type: 'tool_result', toolId, content: event.partialResult, isError: false };
}

export function parseToolExecutionEnd(
  event: Record<string, unknown>,
  state: AssistantStreamState
): OutputEvent {
  return {
    type: 'tool_result',
    toolId: getOptionalString(event, 'toolCallId') ?? state.lastToolId,
    content: event.result ?? '',
    isError: getBoolean(event, 'isError') ?? false,
  };
}

export interface TurnEndOptions {
  readonly failureMessage: string;
  readonly resultFallback?: string | null;
}

export function parseTurnEndResult(
  event: Record<string, unknown>,
  options: TurnEndOptions
): ResultEvent {
  const message = getRecord(event, 'message');
  const usage = message ? (getRecord(message, 'usage') ?? {}) : {};
  const stopReason = message ? getString(message, 'stopReason') : null;
  const errorMessage = message ? getString(message, 'errorMessage') : null;
  const snapshot = message ? assistantSnapshot(message) : { text: '', thinking: '' };
  const success = stopReason !== 'error' && stopReason !== 'aborted' && !errorMessage;
  return {
    type: 'result',
    success,
    result: success ? snapshot.text || options.resultFallback || null : null,
    error: success ? null : (errorMessage ?? stopReason ?? options.failureMessage),
    inputTokens: getNumber(usage, 'input') ?? 0,
    outputTokens: getNumber(usage, 'output') ?? 0,
    cacheReadInputTokens: getNumber(usage, 'cacheRead') ?? 0,
    cacheCreationInputTokens: getNumber(usage, 'cacheWrite') ?? 0,
    cost: getRecord(usage, 'cost') ?? null,
    modelUsage: usage,
  };
}
