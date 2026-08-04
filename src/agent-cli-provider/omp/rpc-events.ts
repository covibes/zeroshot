import { OmpRpcProtocolError, type OmpRpcInboundFrame } from './rpc-protocol';
import { MAX_NORMALIZED_OUTPUT_BYTES } from './rpc-bounds';
import {
  getArray,
  getBoolean,
  getNumber,
  getOptionalString,
  getRecord,
  getString,
  isRecord,
  stringifyContent,
} from '../json';
import type { OutputEvent } from '../types';

export interface OmpRpcEventState {
  lastAssistantText: string;
  lastAssistantThinking: string;
  lastToolId: string | null | undefined;
  normalizedBytes: number;
}

export function createOmpRpcEventState(): OmpRpcEventState {
  return {
    lastAssistantText: '',
    lastAssistantThinking: '',
    lastToolId: undefined,
    normalizedBytes: 0,
  };
}

function assistantSnapshot(message: Record<string, unknown>): { text: string; thinking: string } {
  if (getString(message, 'role') !== 'assistant') return { text: '', thinking: '' };

  let text = '';
  let thinking = '';
  for (const item of getArray(message, 'content')) {
    if (!isRecord(item)) continue;
    const type = getString(item, 'type');
    if (type === 'text') {
      text += getString(item, 'text') ?? '';
    } else if (type === 'thinking') {
      thinking += getString(item, 'thinking') ?? '';
    }
  }

  return { text, thinking };
}

function snapshotDelta(previous: string, current: string): string | null {
  if (!current || previous === current) return null;
  if (current.startsWith(previous)) return current.slice(previous.length) || null;
  return current;
}

function chargeBytes(state: OmpRpcEventState, value: unknown): void {
  const byteLength = Buffer.byteLength(stringifyContent(value), 'utf8');
  state.normalizedBytes += byteLength;
  if (state.normalizedBytes > MAX_NORMALIZED_OUTPUT_BYTES) {
    throw new OmpRpcProtocolError(
      'output-bound-exceeded',
      `Normalized OMP RPC output exceeded the ${MAX_NORMALIZED_OUTPUT_BYTES}-byte cap for this task.`
    );
  }
}

function emitText(state: OmpRpcEventState, text: string): OutputEvent {
  chargeBytes(state, text);
  return { type: 'text', text };
}

function emitThinking(state: OmpRpcEventState, text: string): OutputEvent {
  chargeBytes(state, text);
  return { type: 'thinking', text };
}

function normalizeMessageStart(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const message = getRecord(frame, 'message');
  if (message !== null && getString(message, 'role') === 'assistant') {
    state.lastAssistantText = '';
    state.lastAssistantThinking = '';
  }
  return [];
}

function normalizeAssistantMessageEvent(
  event: Record<string, unknown>,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const type = getString(event, 'type');
  if (type === 'text_delta') {
    const delta = getString(event, 'delta');
    if (!delta) return [];
    state.lastAssistantText += delta;
    return [emitText(state, delta)];
  }
  if (type === 'thinking_delta') {
    const delta = getString(event, 'delta');
    if (!delta) return [];
    state.lastAssistantThinking += delta;
    return [emitThinking(state, delta)];
  }
  return [];
}

function normalizeMessageSnapshot(
  message: Record<string, unknown>,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const snapshot = assistantSnapshot(message);
  const events: OutputEvent[] = [];

  const textDelta = snapshotDelta(state.lastAssistantText, snapshot.text);
  if (textDelta) events.push(emitText(state, textDelta));
  if (snapshot.text) state.lastAssistantText = snapshot.text;

  const thinkingDelta = snapshotDelta(state.lastAssistantThinking, snapshot.thinking);
  if (thinkingDelta) events.push(emitThinking(state, thinkingDelta));
  if (snapshot.thinking) state.lastAssistantThinking = snapshot.thinking;

  return events;
}

function normalizeMessageUpdate(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const assistantMessageEvent = getRecord(frame, 'assistantMessageEvent');
  if (assistantMessageEvent !== null) {
    const events = normalizeAssistantMessageEvent(assistantMessageEvent, state);
    if (events.length > 0) return events;
  }
  const message = getRecord(frame, 'message');
  return message === null ? [] : normalizeMessageSnapshot(message, state);
}

function normalizeMessageEnd(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const message = getRecord(frame, 'message');
  return message === null ? [] : normalizeMessageSnapshot(message, state);
}

function normalizeToolExecutionStart(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const toolId = getOptionalString(frame, 'toolCallId');
  state.lastToolId = toolId;
  const input = frame.args ?? {};
  chargeBytes(state, input);
  return [
    {
      type: 'tool_call',
      toolName: getOptionalString(frame, 'toolName'),
      toolId,
      input,
    },
  ];
}

function normalizeToolExecutionUpdate(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const toolId = getOptionalString(frame, 'toolCallId') ?? state.lastToolId;
  if (toolId !== undefined) state.lastToolId = toolId;
  if (!Object.prototype.hasOwnProperty.call(frame, 'partialResult')) return [];
  chargeBytes(state, frame.partialResult);
  return [
    {
      type: 'tool_result',
      toolId,
      content: frame.partialResult,
      isError: false,
    },
  ];
}

function normalizeToolExecutionEnd(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const toolId = getOptionalString(frame, 'toolCallId') ?? state.lastToolId;
  const content = frame.result ?? '';
  chargeBytes(state, content);
  return [
    {
      type: 'tool_result',
      toolId,
      content,
      isError: getBoolean(frame, 'isError') ?? false,
    },
  ];
}

function normalizeTurnEnd(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const message = getRecord(frame, 'message');
  const usage = message ? (getRecord(message, 'usage') ?? {}) : {};
  const stopReason = message ? getString(message, 'stopReason') : null;
  const errorMessage = message ? getString(message, 'errorMessage') : null;
  const snapshot = message ? assistantSnapshot(message) : { text: '', thinking: '' };
  const success = stopReason !== 'error' && stopReason !== 'aborted' && !errorMessage;
  const result = success ? snapshot.text || state.lastAssistantText || null : null;
  chargeBytes(state, { result, error: errorMessage ?? stopReason ?? null });
  return [
    {
      type: 'result',
      success,
      result,
      error: success ? null : (errorMessage ?? stopReason ?? 'OMP turn failed'),
      inputTokens: getNumber(usage, 'input') ?? 0,
      outputTokens: getNumber(usage, 'output') ?? 0,
      cacheReadInputTokens: getNumber(usage, 'cacheRead') ?? 0,
      cacheCreationInputTokens: getNumber(usage, 'cacheWrite') ?? 0,
      cost: getRecord(usage, 'cost') ?? null,
      modelUsage: usage,
    },
  ];
}

/**
 * Normalize one decoded OMP RPC v2 event frame into zero or more OutputEvents. Only the frame
 * types below produce output; every other known-pre-negotiation frame (agent_start/agent_end,
 * turn_start, ready, response, session_info_update, subagent_*, ...) is protocol/control plumbing
 * the driver consumes directly and must never leak into log/attach/ledger output.
 */
export function normalizeOmpRpcFrame(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  switch (frame.type) {
    case 'message_start':
      return normalizeMessageStart(frame, state);
    case 'message_update':
      return normalizeMessageUpdate(frame, state);
    case 'message_end':
      return normalizeMessageEnd(frame, state);
    case 'tool_execution_start':
      return normalizeToolExecutionStart(frame, state);
    case 'tool_execution_update':
      return normalizeToolExecutionUpdate(frame, state);
    case 'tool_execution_end':
      return normalizeToolExecutionEnd(frame, state);
    case 'turn_end':
      return normalizeTurnEnd(frame, state);
    default:
      return [];
  }
}

export { parseNormalizedOmpRpcEventLine } from './rpc-event-lines';
