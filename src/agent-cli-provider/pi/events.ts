import {
  emitAssistantSnapshot,
  parseAssistantDelta,
  parseToolExecutionEnd,
  parseToolExecutionStart,
  parseToolExecutionUpdate,
  resetAssistantSnapshot,
} from '../assistant-stream';
import { getRecord, getString, isRecord, tryParseJson } from '../json';
import type { OutputEvent, ProviderParserState } from '../types';
import {
  invalidatePiStream,
  rememberPiAssistant,
  rememberPiUsage,
  settlePiStream,
} from './protocol-state';

const IGNORED_EVENT_TYPES = new Set([
  'session',
  'agent_start',
  'agent_end',
  'turn_start',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
]);
const settledStates = new WeakSet<ProviderParserState>();

export function createPiParserState(): ProviderParserState {
  return {
    provider: 'pi',
    lastToolId: undefined,
    lastAssistantText: '',
    lastAssistantThinking: '',
  };
}

function parseMessageEvent(
  type: string,
  event: Record<string, unknown>,
  state: ProviderParserState
): readonly OutputEvent[] | OutputEvent | null | undefined {
  if (type === 'message_start') {
    resetAssistantSnapshot(getRecord(event, 'message'), state);
    return null;
  }
  if (type === 'message_update') {
    const assistantMessageEvent = getRecord(event, 'assistantMessageEvent');
    if (assistantMessageEvent !== null) {
      const assistantEvent = parseAssistantDelta(assistantMessageEvent, state);
      if (assistantEvent !== null) return assistantEvent;
    }
    const message = getRecord(event, 'message');
    return message === null ? null : emitAssistantSnapshot(message, state);
  }
  if (type !== 'message_end') return undefined;

  const message = getRecord(event, 'message');
  if (
    message !== null &&
    getString(message, 'role') === 'toolResult' &&
    Object.hasOwn(message, 'usage')
  ) {
    rememberPiUsage(getRecord(message, 'usage'), state, 'Pi tool usage');
  }
  rememberPiAssistant(message, state);
  return message === null || getString(message, 'role') !== 'assistant'
    ? null
    : emitAssistantSnapshot(message, state);
}

function parseToolEvent(
  type: string,
  event: Record<string, unknown>,
  state: ProviderParserState
): OutputEvent | null | undefined {
  if (type === 'tool_execution_start') return parseToolExecutionStart(event, state);
  if (type === 'tool_execution_update') return parseToolExecutionUpdate(event, state);
  if (type === 'tool_execution_end') return parseToolExecutionEnd(event, state);
  return undefined;
}

function parseKnownPiEvent(
  type: string,
  parsed: Record<string, unknown>,
  state: ProviderParserState
): readonly OutputEvent[] | OutputEvent | null {
  if (type === 'compaction_end') {
    const result = getRecord(parsed, 'result');
    if (result !== null && Object.hasOwn(result, 'usage')) {
      rememberPiUsage(getRecord(result, 'usage'), state, 'Pi compaction usage');
    }
    return null;
  }
  if (type === 'entry_appended') {
    const entry = getRecord(parsed, 'entry');
    if (
      entry !== null &&
      getString(entry, 'type') === 'branch_summary' &&
      Object.hasOwn(entry, 'usage')
    ) {
      rememberPiUsage(getRecord(entry, 'usage'), state, 'Pi branch summary usage');
    }
    return null;
  }
  if (IGNORED_EVENT_TYPES.has(type)) return null;
  const messageEvent = parseMessageEvent(type, parsed, state);
  if (messageEvent !== undefined) return messageEvent;
  const toolEvent = parseToolEvent(type, parsed, state);
  if (toolEvent !== undefined) return toolEvent;
  if (type === 'turn_end') {
    const message = getRecord(parsed, 'message');
    return message === null ? [] : emitAssistantSnapshot(message, state);
  }
  if (type !== 'agent_settled') return null;
  settledStates.add(state);
  return settlePiStream(state);
}

export function parsePiEvent(
  line: string,
  state: ProviderParserState
): readonly OutputEvent[] | OutputEvent | null {
  if (line.trim() && settledStates.has(state)) {
    invalidatePiStream(state, 'stdout contained output after agent_settled.');
    return settlePiStream(state);
  }
  const parsed = tryParseJson(line);
  if (!isRecord(parsed)) {
    if (line.trim()) invalidatePiStream(state, 'stdout contained malformed JSON.');
    return null;
  }

  const type = getString(parsed, 'type');
  if (type === null) {
    invalidatePiStream(state, 'an event was missing its type.');
    return null;
  }
  return parseKnownPiEvent(type, parsed, state);
}

export function finishPiParsing(state: ProviderParserState): OutputEvent | null {
  if (settledStates.has(state)) return null;
  invalidatePiStream(state, 'stdout ended before agent_settled.');
  return settlePiStream(state);
}
