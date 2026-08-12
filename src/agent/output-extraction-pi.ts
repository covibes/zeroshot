import errorDetail = require('./output-extraction-error-detail');
import jsonExtraction = require('./output-extraction-json');
import type {
  CliFailure,
  JsonRecord,
  PiAssistantMessage,
  PiProtocolState,
} from './output-extraction-types';

const { cliErrorDetail } = errorDetail;
const { isObjectRecord, stripTimestamp } = jsonExtraction;

const PI_STOP_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
  'deferred',
]);
const PI_USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const PI_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];

function piProtocolFailure(message: string): CliFailure {
  return { ...cliErrorDetail(message, message), provider: 'pi' };
}

function parsePiProtocolObject(content: string): JsonRecord | null {
  if (!content.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPiNumericFields(value: unknown, fields: readonly string[]): value is JsonRecord {
  return isObjectRecord(value) && fields.every((field) => typeof value[field] === 'number');
}

function isValidPiUsage(usage: unknown): usage is JsonRecord {
  if (!hasPiNumericFields(usage, PI_USAGE_FIELDS)) return false;
  if (!hasPiNumericFields(usage.cost, PI_COST_FIELDS)) return false;
  return (
    (usage.cacheWrite1h === undefined || typeof usage.cacheWrite1h === 'number') &&
    (usage.reasoning === undefined || typeof usage.reasoning === 'number')
  );
}

function isValidPiAssistantMessage(message: unknown): message is PiAssistantMessage {
  return (
    isObjectRecord(message) &&
    message.role === 'assistant' &&
    Array.isArray(message.content) &&
    isValidPiUsage(message.usage) &&
    typeof message.stopReason === 'string' &&
    PI_STOP_REASONS.has(message.stopReason)
  );
}

function piMessageRole(message: unknown): string | null {
  if (!isObjectRecord(message)) return null;
  return typeof message.role === 'string' ? message.role : null;
}

function piFailureFromMessage(message: PiAssistantMessage): CliFailure | null {
  const stopReason = message.stopReason;
  const errorMessage = message.errorMessage;
  if (stopReason === 'deferred') {
    return {
      ...cliErrorDetail('Pi turn deferred without completing.', 'Pi turn deferred'),
      provider: 'pi',
    };
  }
  if (stopReason !== 'error' && stopReason !== 'aborted' && !errorMessage) return null;
  return {
    ...cliErrorDetail(errorMessage || stopReason, 'Pi turn failed'),
    provider: 'pi',
  };
}

function isIgnoredPiLine(content: string): boolean {
  return (
    content.startsWith('[ZEROSHOT] Earlier provider output omitted') ||
    content.startsWith('[ZEROSHOT] Provider output record retained') ||
    content.startsWith('[ZEROSHOT][PROVIDER_STDERR] ')
  );
}

function applyPiMessageEnd(message: unknown, state: PiProtocolState): CliFailure | null {
  const role = piMessageRole(message);
  if (role === null) return piProtocolFailure('Pi message_end did not contain a valid message.');
  if (role !== 'assistant') return null;
  if (!isValidPiAssistantMessage(message)) {
    return piProtocolFailure('Pi message_end did not contain a valid assistant message.');
  }
  state.latestAssistant = message;
  return null;
}

function applyPiEvent(parsed: JsonRecord, state: PiProtocolState): CliFailure | null {
  if (typeof parsed.type !== 'string') {
    return piProtocolFailure('Pi JSON stream contained an event without a valid type.');
  }
  if (parsed.type === 'message_end') return applyPiMessageEnd(parsed.message, state);
  if (parsed.type === 'agent_settled') state.settled = true;
  return null;
}

function applyPiProtocolLine(content: string, state: PiProtocolState): CliFailure | null {
  if (!content || isIgnoredPiLine(content)) return null;
  if (state.settled) return piProtocolFailure('Pi emitted output after agent_settled.');

  const parsed = parsePiProtocolObject(content);
  if (parsed === null) return piProtocolFailure('Pi JSON stream contained malformed output.');
  return applyPiEvent(parsed, state);
}

function extractSettledPiFailure(lines: readonly string[]): CliFailure | null {
  const state: PiProtocolState = { latestAssistant: null, settled: false };
  for (const line of lines) {
    const content = stripTimestamp(line);
    const failure = applyPiProtocolLine(content, state);
    if (failure) return failure;
  }

  if (!state.settled) return piProtocolFailure('Pi JSON stream ended before agent_settled.');
  if (state.latestAssistant === null) {
    return piProtocolFailure('Pi settled without a valid assistant message_end.');
  }
  return piFailureFromMessage(state.latestAssistant);
}

export = {
  extractSettledPiFailure,
};
