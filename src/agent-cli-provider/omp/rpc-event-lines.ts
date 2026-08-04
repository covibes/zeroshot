import { getNumber, getOptionalString, getString, isRecord, tryParseJson } from '../json';
import type { ProviderParseResult, ProviderParserState } from '../types';

/**
 * Parse one line of the rpc-stdio lane's already-normalized OutputEvent JSON stream. The driver
 * normalizes raw RPC frames once; this validating passthrough keeps generic log and attach tooling
 * on the provider adapter contract without re-deriving events from raw frames.
 */
export function parseNormalizedOmpRpcEventLine(
  line: string,
  _state: ProviderParserState
): ProviderParseResult {
  const parsed = tryParseJson(line);
  if (!isRecord(parsed)) return null;
  switch (parsed.type) {
    case 'text':
    case 'thinking': {
      const text = getString(parsed, 'text');
      return text === null ? null : { type: parsed.type, text };
    }
    case 'tool_call':
      return {
        type: 'tool_call',
        toolName: getOptionalString(parsed, 'toolName'),
        toolId: getOptionalString(parsed, 'toolId'),
        input: parsed.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolId: getOptionalString(parsed, 'toolId'),
        content: parsed.content,
        isError: parsed.isError,
      };
    case 'result': {
      if (typeof parsed.success !== 'boolean') return null;
      const inputTokens = getNumber(parsed, 'inputTokens');
      const outputTokens = getNumber(parsed, 'outputTokens');
      const cacheReadInputTokens = getNumber(parsed, 'cacheReadInputTokens');
      const cacheCreationInputTokens = getNumber(parsed, 'cacheCreationInputTokens');
      return {
        type: 'result',
        success: parsed.success,
        result: parsed.result,
        error: parsed.error,
        cost: parsed.cost,
        duration: parsed.duration,
        ...(inputTokens === null ? {} : { inputTokens }),
        ...(outputTokens === null ? {} : { outputTokens }),
        ...(cacheReadInputTokens === null ? {} : { cacheReadInputTokens }),
        ...(cacheCreationInputTokens === null ? {} : { cacheCreationInputTokens }),
        modelUsage: parsed.modelUsage,
      };
    }
    default:
      return null;
  }
}
