import {
  emitAssistantSnapshot,
  parseAssistantDelta,
  parseToolExecutionEnd,
  parseToolExecutionStart,
  parseToolExecutionUpdate,
  parseTurnEndResult,
  resetAssistantSnapshot,
} from '../assistant-stream';
import { getRecord, getString, stringifyContent } from '../json';
import type { OutputEvent } from '../types';
import { MAX_NORMALIZED_OUTPUT_BYTES } from './rpc-bounds';
import { OmpRpcProtocolError, type OmpRpcInboundFrame } from './rpc-protocol';

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

function chargeBytes(state: OmpRpcEventState, value: unknown): void {
  state.normalizedBytes += Buffer.byteLength(stringifyContent(value), 'utf8');
  if (state.normalizedBytes > MAX_NORMALIZED_OUTPUT_BYTES) {
    throw new OmpRpcProtocolError(
      'output-bound-exceeded',
      `Normalized OMP RPC output exceeded the ${MAX_NORMALIZED_OUTPUT_BYTES}-byte cap for this task.`
    );
  }
}

function chargeEvent(state: OmpRpcEventState, event: OutputEvent): void {
  switch (event.type) {
    case 'text':
    case 'thinking':
      chargeBytes(state, event.text);
      break;
    case 'tool_call':
      chargeBytes(state, event.input);
      break;
    case 'tool_result':
      chargeBytes(state, event.content);
      break;
    case 'result':
      chargeBytes(state, { result: event.result, error: event.error });
      break;
    default:
      break;
  }
}

function chargeEvents(
  state: OmpRpcEventState,
  events: readonly OutputEvent[]
): readonly OutputEvent[] {
  for (const event of events) chargeEvent(state, event);
  return events;
}

function normalizeMessageUpdate(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const assistantMessageEvent = getRecord(frame, 'assistantMessageEvent');
  if (assistantMessageEvent !== null) {
    const event = parseAssistantDelta(assistantMessageEvent, state);
    if (event !== null) {
      chargeEvent(state, event);
      return [event];
    }
  }
  const message = getRecord(frame, 'message');
  return message === null
    ? []
    : chargeEvents(state, emitAssistantSnapshot(message, state, { retainPreviousOnEmpty: true }));
}

function normalizeMessageSnapshot(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const message = getRecord(frame, 'message');
  return message === null
    ? []
    : chargeEvents(state, emitAssistantSnapshot(message, state, { retainPreviousOnEmpty: true }));
}

function normalizeToolEvent(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const event =
    frame.type === 'tool_execution_start'
      ? parseToolExecutionStart(frame, state)
      : frame.type === 'tool_execution_update'
        ? parseToolExecutionUpdate(frame, state)
        : parseToolExecutionEnd(frame, state);
  if (event === null) return [];
  chargeEvent(state, event);
  return [event];
}

function normalizeTurnEnd(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  const event = parseTurnEndResult(frame, {
    failureMessage: 'OMP turn failed',
    resultFallback: state.lastAssistantText,
  });
  const message = getRecord(frame, 'message');
  const stopReason = message === null ? null : getString(message, 'stopReason');
  const errorMessage = message === null ? null : getString(message, 'errorMessage');
  chargeBytes(state, { result: event.result, error: errorMessage ?? stopReason ?? null });
  return [event];
}

/**
 * Normalize one decoded OMP RPC v2 event frame into zero or more OutputEvents. Control frames never
 * leak into log, attach, or ledger output.
 */
export function normalizeOmpRpcFrame(
  frame: OmpRpcInboundFrame,
  state: OmpRpcEventState
): readonly OutputEvent[] {
  switch (frame.type) {
    case 'message_start':
      resetAssistantSnapshot(getRecord(frame, 'message'), state);
      return [];
    case 'message_update':
      return normalizeMessageUpdate(frame, state);
    case 'message_end':
      return normalizeMessageSnapshot(frame, state);
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return normalizeToolEvent(frame, state);
    case 'turn_end':
      return normalizeTurnEnd(frame, state);
    default:
      return [];
  }
}

export { parseNormalizedOmpRpcEventLine } from './rpc-event-lines';
