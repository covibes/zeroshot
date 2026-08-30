import type { JsonRecord, ProvidersParserBoundary } from './output-extraction-types';
import { decodeTaskLogLine } from '../task-log-line';

function isObjectRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProvidersParserBoundary(value: unknown): value is ProvidersParserBoundary {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'parseProviderChunk' in value &&
    typeof value.parseProviderChunk === 'function'
  );
}

const rawProviders: unknown = require('../providers');
if (!isProvidersParserBoundary(rawProviders)) {
  throw new TypeError('providers module must expose parseProviderChunk');
}
const { parseProviderChunk } = rawProviders;

function prefixedJsonBody(text: string): string | null {
  if (text.startsWith('{') || text.startsWith('[')) return null;
  const separatorIndex = text.indexOf('|');
  if (separatorIndex < 1 || separatorIndex > 40) return null;
  const body = text.slice(separatorIndex + 1).trimStart();
  return body.startsWith('{') || body.startsWith('[') ? body : null;
}

function stripTimestamp(line: unknown): string {
  if (!line || typeof line !== 'string') return '';
  const normalized = line.trim().replace(/\r$/, '');
  if (!normalized) return '';

  const decoded = decodeTaskLogLine(normalized);
  if (!decoded.providerOutput) return '';
  return prefixedJsonBody(decoded.content) ?? decoded.content;
}

function parseJsonRecordLine(line: string): JsonRecord | null {
  const content = stripTimestamp(line);
  if (!content.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractFromResultWrapper(output: string): object | null {
  for (const line of output.split('\n')) {
    const parsed = parseJsonRecordLine(line);
    if (parsed === null) continue;
    const extracted = extractResultContent(parsed);
    if (extracted) return extracted;
  }
  return null;
}

function extractResultContent(value: unknown): object | null {
  if (!isObjectRecord(value) || value.type !== 'result') return null;

  const structuredOutput = value.structured_output;
  if (structuredOutput && typeof structuredOutput === 'object') return structuredOutput;

  const result = value.result;
  if (!result) return null;
  if (typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  return extractFromMarkdown(result) || extractDirectJson(result);
}

function normalizedProviderOutput(output: string): string {
  const normalized: string[] = [];
  for (const line of output.split('\n')) {
    const content = stripTimestamp(line);
    if (content) normalized.push(content);
  }
  return normalized.join('\n');
}

function providerEventText(event: unknown): string | null {
  if (!isObjectRecord(event) || event.type !== 'text' || typeof event.text !== 'string') {
    return null;
  }
  return event.text;
}

function extractTextCandidate(text: string): object | null {
  return extractDirectJson(text) || extractFromMarkdown(text);
}

function collectProviderText(events: readonly unknown[]): string[] {
  const textEvents: string[] = [];
  for (const event of events) {
    const text = providerEventText(event);
    if (text !== null) textEvents.push(text);
  }
  return textEvents;
}

function latestTextCandidate(textEvents: readonly string[]): object | null {
  for (let index = textEvents.length - 1; index >= 0; index--) {
    const text = textEvents[index];
    if (text === undefined) continue;
    const extracted = extractTextCandidate(text);
    if (extracted) return extracted;
  }
  return null;
}

function extractFromTextEvents(output: string, providerName: string): object | null {
  const events = parseProviderChunk(providerName, normalizedProviderOutput(output));
  const textEvents = collectProviderText(events);
  const latest = latestTextCandidate(textEvents);
  if (latest) return latest;

  const textContent = textEvents.join('');
  if (!textContent.trim()) return null;

  return extractTextCandidate(textContent) || latestTextCandidate(textEvents);
}

function extractModelTextFromOutput(output: unknown, providerName: string): string | null {
  if (!output || typeof output !== 'string') return null;
  const textEvents: string[] = [];
  const events = parseProviderChunk(providerName, normalizedProviderOutput(output));
  for (const event of events) {
    const text = providerEventText(event);
    if (text !== null) textEvents.push(text);
  }
  const text = textEvents.join('');
  return text.trim() ? text : null;
}

function extractFromMarkdown(text: unknown): object | null {
  if (!text || typeof text !== 'string') return null;

  const match = /```json\s*([\s\S]*?)```/.exec(text);
  const encoded = match?.[1];
  if (encoded === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(encoded.trim());
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const CLI_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'duration_ms',
  'duration_api_ms',
  'total_cost_usd',
  'session_id',
  'num_turns',
  'permission_denials',
  'modelUsage',
]);

function isCliMetadata(value: JsonRecord): boolean {
  if (value.type === 'result') return true;

  let metadataFieldCount = 0;
  for (const key of Object.keys(value)) {
    if (CLI_METADATA_FIELDS.has(key)) metadataFieldCount++;
  }
  return metadataFieldCount >= 2;
}

function extractDirectJson(text: unknown): JsonRecord | null {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isObjectRecord(parsed) || isCliMetadata(parsed)) return null;
    return parsed;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const substring = trimmed.slice(firstBrace, lastBrace + 1);
        const parsedSubstring: unknown = JSON.parse(substring);
        if (isObjectRecord(parsedSubstring) && !isCliMetadata(parsedSubstring)) {
          return parsedSubstring;
        }
      } catch {
        // Fallthrough to null
      }
    }
    return null;
  }
}

function hasFatalStandaloneOutput(output: unknown): boolean {
  if (!output || typeof output !== 'string') return false;
  for (const line of output.split('\n')) {
    const stripped = stripTimestamp(line).trim();
    if (!stripped) continue;
    if (/^(task not found|process terminated)\b/i.test(stripped)) return true;
  }
  return false;
}

function extractJsonFromOutput(output: unknown, providerName = 'claude'): object | null {
  if (!output || typeof output !== 'string') return null;

  const trimmedOutput = output.trim();
  if (!trimmedOutput) return null;

  const fromWrapper = extractFromResultWrapper(trimmedOutput);
  if (fromWrapper) return fromWrapper;

  const fromText = extractFromTextEvents(trimmedOutput, providerName);
  if (fromText) return fromText;

  const fromMarkdown = extractFromMarkdown(trimmedOutput);
  if (fromMarkdown) return fromMarkdown;

  const fromDirect = extractDirectJson(trimmedOutput);
  if (fromDirect) return fromDirect;

  if (hasFatalStandaloneOutput(trimmedOutput)) return null;
  return null;
}

export = {
  extractDirectJson,
  extractFromMarkdown,
  extractFromResultWrapper,
  extractFromTextEvents,
  extractJsonFromOutput,
  extractModelTextFromOutput,
  hasFatalStandaloneOutput,
  isObjectRecord,
  parseJsonRecordLine,
  stripTimestamp,
};
