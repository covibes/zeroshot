import fs = require('fs');
import path = require('path');
import { getProviderAdapter, type ProviderAdapter } from './agent-provider-boundary';
import {
  compareText,
  createExclusiveDestination,
  createRecordWriter,
  nullableString,
  type RecordWriter,
} from './export-stream';
import {
  reportDiagnostic,
  SEMANTIC_BOUNDS,
  SEMANTIC_MEDIA_TYPE,
  SEMANTIC_SCHEMA_VERSION,
  type OpenedEvidence,
  type SemanticExportOptions,
  type SemanticTask,
  type TaskProjection,
} from './semantic-contract';
import { emptyEvidence, openEvidence } from './semantic-evidence';
import { parseOpenedEvidence } from './semantic-parser';
import {
  collectTaskCauses,
  expectedLogPath,
  hasTerminalTaskStatus,
  logicalTaskRef,
  readTraceTask,
  type TaskCause,
} from './trace-evidence';
import { TRACE_OUTPUT_CHUNK_BYTES } from './trace-output';

interface StreamTaskOptions {
  writer: RecordWriter;
  taskId: string;
  cause: TaskCause;
  readTask: SemanticExportOptions['readTask'];
  allowedLogRoot: string;
  footerIssues: string[];
}

interface TaskRecordOptions {
  writer: RecordWriter;
  taskId: string;
  agentId: string | null;
  task: SemanticTask | null;
  adapter: ProviderAdapter | null;
  evidence: OpenedEvidence;
}

interface InitialIssueOptions {
  agentIds: readonly string[];
  taskIssue: string | null;
  taskPresent: boolean;
  taskTerminal: boolean;
  evidenceIssue: string | null;
}

function assertOutputIsNotTaskLog(
  outputPath: string | null | undefined,
  allowedLogRoot: string,
  taskIds: Iterable<string>
): void {
  if (!outputPath) return;
  const resolvedOutput = path.resolve(outputPath);
  for (const taskId of taskIds) {
    if (expectedLogPath(allowedLogRoot, taskId) === resolvedOutput) {
      throw new Error('Semantic export output cannot replace a source task log');
    }
  }
}

function resolveAdapter(provider: string | null): ProviderAdapter | null {
  if (!provider) return null;
  try {
    return getProviderAdapter(provider);
  } catch {
    return null;
  }
}

function taskPrompt(task: SemanticTask | null): string | null {
  if (!task) return null;
  return nullableString(task.fullPrompt) ?? nullableString(task.prompt);
}

function writeTaskRecord(options: TaskRecordOptions): void {
  const { writer, taskId, agentId, task, adapter, evidence } = options;
  writer.write({
    record_type: 'task',
    task_id: taskId,
    agent_id: agentId,
    provider: nullableString(task?.provider),
    adapter_id: adapter?.id ?? null,
    adapter_version: adapter?.adapterVersion ?? null,
    model: nullableString(task?.model),
    prompt_ref: logicalTaskRef(taskId, 'prompt'),
    prompt: taskPrompt(task),
    raw_output_ref: logicalTaskRef(taskId, 'output'),
    raw_output_sha256: evidence.sha256,
    raw_output_byte_length: evidence.byteLength,
  });
}

function createTaskProjection(
  writer: RecordWriter,
  taskId: string,
  provider: string | null,
  adapter: ProviderAdapter | null,
  evidence: OpenedEvidence
): TaskProjection {
  return {
    writer,
    taskId,
    provider,
    adapter,
    promptRef: logicalTaskRef(taskId, 'prompt'),
    rawOutputRef: logicalTaskRef(taskId, 'output'),
    rawOutputSha256: evidence.sha256,
    eventIndex: 0,
    diagnosticIndex: 0,
    diagnosticsOmitted: 0,
    issueCodes: new Set<string>(),
    logFormat: provider === 'pi' ? 'legacy-pi' : null,
    terminalResultEmitted: false,
  };
}

function reportInitialIssues(context: TaskProjection, options: InitialIssueOptions): void {
  if (options.agentIds.length > 1) reportDiagnostic(context, 'ambiguous_agent', null);
  if (options.taskIssue) {
    reportDiagnostic(context, options.taskIssue.split(':').at(-1) || 'task_row_unreadable', null);
  }
  if (options.taskPresent && !options.taskTerminal) {
    reportDiagnostic(context, 'task_not_terminal', null);
  }
  if (options.evidenceIssue) reportDiagnostic(context, options.evidenceIssue, null);
  if (options.taskPresent && !context.adapter) reportDiagnostic(context, 'unknown_provider', null);
}

function streamSemanticTask(options: StreamTaskOptions): { events: number; diagnostics: number } {
  const { writer, taskId, cause, readTask, allowedLogRoot, footerIssues } = options;
  const taskRead = readTraceTask(taskId, readTask);
  const task = taskRead.task as SemanticTask | null;
  const provider = nullableString(task?.provider);
  const adapter = resolveAdapter(provider);
  const evidence = task ? openEvidence(taskId, task, allowedLogRoot) : emptyEvidence();
  const agentIds = [...cause.agentIds].sort(compareText);
  const taskTerminal = task !== null && hasTerminalTaskStatus(task);
  writeTaskRecord({
    writer,
    taskId,
    agentId: agentIds.length === 1 ? (agentIds[0] ?? null) : null,
    task,
    adapter,
    evidence,
  });
  const context = createTaskProjection(writer, taskId, provider, adapter, evidence);
  reportInitialIssues(context, {
    agentIds,
    taskIssue: taskRead.issue,
    taskPresent: task !== null,
    taskTerminal,
    evidenceIssue: evidence.issue,
  });
  let sourceStable = evidence.issue === null && evidence.fd !== null;
  if (sourceStable && adapter) sourceStable = parseOpenedEvidence(evidence, context, adapter);
  if (evidence.fd !== null) fs.closeSync(evidence.fd);
  const sourceComplete = sourceStable && taskTerminal;
  const semanticComplete = sourceComplete && adapter !== null && context.issueCodes.size === 0;
  for (const code of context.issueCodes) footerIssues.push(`task:${taskId}:${code}`);
  writer.write({
    record_type: 'task_end',
    task_id: taskId,
    source_complete: sourceComplete,
    semantic_complete: semanticComplete,
    events: context.eventIndex,
    diagnostics: context.diagnosticIndex,
    diagnostics_omitted: context.diagnosticsOmitted,
  });
  return { events: context.eventIndex, diagnostics: context.diagnosticIndex };
}

function streamClusterSemanticExport(options: SemanticExportOptions): void {
  const { ledger, clusterId, readTask, allowedLogRoot, outputPath = null } = options;
  const causes = collectTaskCauses(ledger, clusterId);
  assertOutputIsNotTaskLog(outputPath, allowedLogRoot, causes.keys());
  const destination = createExclusiveDestination(
    outputPath,
    options.stdout ?? process.stdout,
    'Semantic'
  );
  const writer = createRecordWriter(destination);
  const footerIssues: string[] = [];
  let events = 0;
  let diagnostics = 0;
  try {
    writer.write({
      record_type: 'header',
      schema_version: SEMANTIC_SCHEMA_VERSION,
      media_type: SEMANTIC_MEDIA_TYPE,
      cluster_id: clusterId,
      bounds: {
        read_chunk_bytes: TRACE_OUTPUT_CHUNK_BYTES,
        max_line_bytes: SEMANTIC_BOUNDS.maxLineBytes,
        max_event_bytes: SEMANTIC_BOUNDS.maxEventBytes,
        max_string_bytes: SEMANTIC_BOUNDS.maxStringBytes,
        max_value_depth: SEMANTIC_BOUNDS.maxValueDepth,
        max_container_items: SEMANTIC_BOUNDS.maxContainerItems,
        max_value_nodes: SEMANTIC_BOUNDS.maxValueNodes,
        max_events_per_task: SEMANTIC_BOUNDS.maxEventsPerTask,
        max_diagnostics_per_task: SEMANTIC_BOUNDS.maxDiagnosticsPerTask,
      },
    });
    const ordered = [...causes.entries()].sort(([left], [right]) => compareText(left, right));
    for (const [taskId, cause] of ordered) {
      const summary = streamSemanticTask({
        writer,
        taskId,
        cause,
        readTask,
        allowedLogRoot,
        footerIssues,
      });
      events += summary.events;
      diagnostics += summary.diagnostics;
    }
    footerIssues.sort(compareText);
    writer.finish({
      record_type: 'footer',
      complete: footerIssues.length === 0,
      tasks: causes.size,
      events,
      diagnostics,
      issues: footerIssues,
    });
  } finally {
    destination.close();
  }
}

export = {
  SEMANTIC_EXPORT_BOUNDS: SEMANTIC_BOUNDS,
  streamClusterSemanticExport,
};
