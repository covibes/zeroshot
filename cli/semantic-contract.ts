import type { ProviderAdapter } from './agent-provider-boundary';
import type { ExportStream, RecordWriter } from './export-stream';
import type { ClusterLedger } from './trace-evidence';
import type fs = require('fs');
import { decodeTaskLogLine } from '../src/task-log-line';

export const SEMANTIC_SCHEMA_VERSION = 'zeroshot.semantic.v1';
export const SEMANTIC_MEDIA_TYPE = 'application/x-zeroshot-semantic+jsonl';
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_EVENT_BYTES = 512 * 1024;
export const MAX_STRING_BYTES = 256 * 1024;
export const MAX_VALUE_DEPTH = 32;
export const MAX_CONTAINER_ITEMS = 4096;
export const MAX_VALUE_NODES = 16384;
export const MAX_EVENTS_PER_TASK = 100000;
export const MAX_DIAGNOSTICS_PER_TASK = 1000;
export const SEMANTIC_BOUNDS = {
  maxLineBytes: MAX_LINE_BYTES,
  maxEventBytes: MAX_EVENT_BYTES,
  maxStringBytes: MAX_STRING_BYTES,
  maxValueDepth: MAX_VALUE_DEPTH,
  maxContainerItems: MAX_CONTAINER_ITEMS,
  maxValueNodes: MAX_VALUE_NODES,
  maxEventsPerTask: MAX_EVENTS_PER_TASK,
  maxDiagnosticsPerTask: MAX_DIAGNOSTICS_PER_TASK,
} as const;

const WRAPPER_LINE_PATTERNS = [
  /^={50}$/,
  /^Finished: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /^Exit code: (?:-?\d+|null), Signal: (?:[A-Za-z0-9]+|null)$/,
  /^Stop reason: [^,]+, Exit code: (?:-?\d+|null), Signal: (?:[A-Za-z0-9]+|null)$/,
] as const;
export interface SemanticTask {
  id?: unknown;
  fullPrompt?: unknown;
  prompt?: unknown;
  status?: unknown;
  provider?: unknown;
  model?: unknown;
  logFile?: unknown;
}

export interface SemanticExportOptions {
  ledger: ClusterLedger;
  clusterId: string;
  readTask(taskId: string): SemanticTask | null;
  allowedLogRoot: string;
  outputPath?: string | null;
  stdout?: ExportStream;
}

export interface SourceSpan {
  line_number: number;
  byte_start: number;
  byte_end: number;
  timestamp_ms: number | null;
}

export interface TaskProjection {
  writer: RecordWriter;
  taskId: string;
  provider: string | null;
  adapter: ProviderAdapter | null;
  promptRef: string;
  rawOutputRef: string;
  rawOutputSha256: string | null;
  eventIndex: number;
  diagnosticIndex: number;
  diagnosticsOmitted: number;
  issueCodes: Set<string>;
  logFormat: TaskLogFormat | null;
  terminalResultEmitted: boolean;
}

export interface OpenedEvidence {
  fd: number | null;
  before: fs.BigIntStats | null;
  byteLength: number | null;
  sha256: string | null;
  issue: string | null;
}

type TaskLogFormat = 'legacy-pi' | 'stderr-tagged-v1' | 'channel-framed-v2';
export type OwnedLogLine = 'format-v1' | 'format-v2' | 'owned' | null;

export function classifyOwnedLogLine(rawLine: string): OwnedLogLine {
  const line = rawLine.trim();
  if (!line) return 'owned';
  if (WRAPPER_LINE_PATTERNS.some((pattern) => pattern.test(line))) return 'owned';
  const decoded = decodeTaskLogLine(rawLine);
  if (decoded.format === 'stderr-tagged-v1') return 'format-v1';
  if (decoded.format === 'channel-framed-v2') return 'format-v2';
  return decoded.providerOutput ? null : 'owned';
}

function diagnosticMessage(code: string): string {
  const messages: Record<string, string> = {
    ambiguous_agent: 'Task evidence has more than one causal agent.',
    event_invalid: 'Provider adapter emitted an invalid OutputEvent.',
    event_limit_exceeded: 'Semantic event count exceeded the per-task bound.',
    event_shape_too_deep: 'OutputEvent JSON exceeded the nesting bound.',
    event_shape_too_large: 'OutputEvent JSON exceeded the node bound.',
    event_shape_too_wide: 'OutputEvent JSON exceeded the container bound.',
    event_string_too_large: 'OutputEvent string exceeded the byte bound.',
    event_too_large: 'Canonical OutputEvent exceeded the byte bound.',
    event_value_not_json: 'OutputEvent contained a non-JSON value.',
    invalid_json_shape: 'Provider source line was not a JSON object.',
    invalid_utf8: 'Provider source line was not valid UTF-8.',
    legacy_ambiguous_channels: 'Legacy task log does not prove stdout and stderr provenance.',
    line_too_large: 'Provider source line exceeded the byte bound.',
    log_changed_during_parse: 'Raw provider output changed during semantic projection.',
    log_changed_during_hash: 'Raw provider output changed while its digest was computed.',
    log_missing: 'Raw provider output is missing.',
    log_not_regular: 'Raw provider output is not a regular file.',
    log_read_failed: 'Raw provider output could not be read completely.',
    log_reference_invalid: 'Task raw-output reference is outside the owned log boundary.',
    log_unreadable: 'Raw provider output could not be opened safely.',
    malformed_json: 'Provider source line contained malformed JSON.',
    output_after_terminal: 'Provider output followed the terminal result.',
    parser_error: 'Provider adapter rejected a source line.',
    parser_finish_error: 'Provider adapter failed while finishing its stateful parse.',
    task_not_terminal: 'Task-store row was not terminal when evidence was captured.',
    task_row_identity_mismatch: 'Task-store identity did not match causal ledger identity.',
    task_row_missing: 'Causally referenced task-store row is missing.',
    task_row_unreadable: 'Causally referenced task-store row could not be read.',
    terminal_result_missing: 'Provider evidence did not produce one terminal result.',
    unframed_log_line: 'A channel-framed task log contained an unframed source line.',
    unknown_provider: 'Task provider has no registered Zeroshot adapter.',
  };
  return messages[code] || 'Semantic projection was incomplete.';
}

export function reportDiagnostic(
  context: TaskProjection,
  code: string,
  source: SourceSpan | null
): void {
  context.issueCodes.add(code);
  if (context.diagnosticIndex >= MAX_DIAGNOSTICS_PER_TASK) {
    context.diagnosticsOmitted += 1;
    return;
  }
  context.writer.write({
    record_type: 'diagnostic',
    task_id: context.taskId,
    diagnostic_index: context.diagnosticIndex,
    code,
    message: diagnosticMessage(code),
    source,
  });
  context.diagnosticIndex += 1;
}
