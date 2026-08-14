import { TextDecoder } from 'node:util';
import { stripTimestampPrefix, type ProviderAdapter } from './agent-provider-boundary';
import {
  classifyOwnedLogLine,
  reportDiagnostic,
  type SourceSpan,
  type TaskProjection,
} from './semantic-contract';
import { emitEvent, emittedEvents } from './semantic-events';
import { decodeTaskLogLine } from '../src/task-log-line';

function jsonLineIssue(content: string, providerId: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const candidate = providerId === 'pi' || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'malformed_json';
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? null
    : 'invalid_json_shape';
}

function decodeLine(
  context: TaskProjection,
  line: Buffer | null,
  source: SourceSpan
): string | null {
  if (line === null) {
    reportDiagnostic(context, 'line_too_large', source);
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    reportDiagnostic(context, 'invalid_utf8', source);
    return null;
  }
}

export function handleProviderLine(
  context: TaskProjection,
  state: ReturnType<ProviderAdapter['createParserState']>,
  line: Buffer | null,
  source: SourceSpan
): void {
  const rawLine = decodeLine(context, line, source);
  if (rawLine === null) return;
  const timestamp = /^\[(\d{13})\]/.exec(rawLine);
  source.timestamp_ms = timestamp ? Number(timestamp[1]) : null;
  if (skipOwnedOrAmbiguous(context, rawLine, source)) return;
  let content: string | null = stripTimestampPrefix(rawLine);
  if (context.logFormat === 'channel-framed-v2') {
    const decoded = decodeTaskLogLine(rawLine);
    content = decoded.channel === 'provider_stdout' ? decoded.content : null;
  }
  if (content === null) {
    reportDiagnostic(context, 'unframed_log_line', source);
    return;
  }
  parseProviderContent(context, state, content, source);
}

function skipOwnedOrAmbiguous(
  context: TaskProjection,
  rawLine: string,
  source: SourceSpan
): boolean {
  const owned = classifyOwnedLogLine(rawLine);
  if (owned === 'format-v1') {
    context.logFormat = 'stderr-tagged-v1';
    return true;
  }
  if (owned === 'format-v2') {
    context.logFormat = 'channel-framed-v2';
    return true;
  }
  if (owned === 'owned') return true;
  if (context.provider !== 'pi' && context.logFormat === null) {
    if (!context.issueCodes.has('legacy_ambiguous_channels')) {
      reportDiagnostic(context, 'legacy_ambiguous_channels', source);
    }
    return true;
  }
  return false;
}

function parseProviderContent(
  context: TaskProjection,
  state: ReturnType<ProviderAdapter['createParserState']>,
  content: string,
  source: SourceSpan
): void {
  const lineIssue = jsonLineIssue(content, context.adapter?.id || '');
  if (lineIssue) reportDiagnostic(context, lineIssue, source);
  try {
    const result = context.adapter?.parseEvent(content, state) ?? null;
    for (const event of emittedEvents(result)) emitEvent(context, event, source, 'line');
  } catch {
    reportDiagnostic(context, 'parser_error', source);
  }
}
