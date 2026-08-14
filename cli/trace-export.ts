import path = require('path');
import {
  compareText,
  createExclusiveDestination,
  createRecordWriter,
  nullableString,
  type ExportStream,
  type RecordWriter,
} from './export-stream';
import {
  collectTaskCauses,
  expectedLogPath,
  forEachLedgerMessage,
  hasTerminalTaskStatus,
  logicalTaskRef,
  readTraceTask,
  type ClusterLedger,
  type TaskCause,
  type TraceTask,
} from './trace-evidence';
import { streamTaskOutput, TRACE_OUTPUT_CHUNK_BYTES, writeUnavailableOutput } from './trace-output';

const TRACE_SCHEMA_VERSION = 'zeroshot.trace.v1';
const TRACE_MEDIA_TYPE = 'application/x-zeroshot-trace+jsonl';

interface TraceExportOptions {
  ledger: ClusterLedger;
  clusterId: string;
  readTask(taskId: string): TraceTask | null;
  allowedLogRoot: string;
  outputPath?: string | null;
  stdout?: ExportStream;
}

interface StreamTaskOptions {
  writer: RecordWriter;
  taskId: string;
  cause: TaskCause;
  readTask(taskId: string): TraceTask | null;
  allowedLogRoot: string;
  issues: string[];
}

function nullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function assertOutputDoesNotReplaceTaskLog(
  outputPath: string | null | undefined,
  allowedLogRoot: string,
  taskIds: Iterable<string>
): void {
  if (!outputPath) return;
  const resolvedOutput = path.resolve(outputPath);
  for (const taskId of taskIds) {
    if (expectedLogPath(allowedLogRoot, taskId) === resolvedOutput) {
      throw new Error('Trace export output cannot replace a source task log');
    }
  }
}

function taskPrompt(task: TraceTask): string | null {
  return nullableString(task.fullPrompt) ?? nullableString(task.prompt);
}

function streamTask(options: StreamTaskOptions): { bytes: number } {
  const { writer, taskId, cause, readTask, allowedLogRoot, issues } = options;
  const agentIds = [...cause.agentIds].sort(compareText);
  if (agentIds.length > 1) issues.push(`task:${taskId}:ambiguous_agent`);
  const taskRead = readTraceTask(taskId, readTask);
  const task = taskRead.task;
  if (taskRead.issue) issues.push(taskRead.issue);
  const taskTerminal = task !== null && hasTerminalTaskStatus(task);
  if (task && !taskTerminal) issues.push(`task:${taskId}:task_not_terminal`);
  const promptRef = logicalTaskRef(taskId, 'prompt');
  const rawOutputRef = logicalTaskRef(taskId, 'output');
  writer.write({
    record_type: 'task',
    task_id: taskId,
    agent_id: agentIds.length === 1 ? agentIds[0] : null,
    provider: nullableString(task?.provider),
    model: nullableString(task?.model),
    status: nullableString(task?.status),
    created_at: nullableString(task?.createdAt),
    updated_at: nullableString(task?.updatedAt),
    exit_code: nullableInteger(task?.exitCode),
    prompt_ref: promptRef,
    prompt: task ? taskPrompt(task) : null,
    raw_output_ref: rawOutputRef,
  });
  if (!task) {
    writeUnavailableOutput(writer, taskId, rawOutputRef);
    return { bytes: 0 };
  }
  return streamTaskOutput({
    writer,
    taskId,
    task,
    allowedLogRoot,
    rawOutputRef,
    taskTerminal,
    issues,
  });
}

function streamClusterTraceExport(options: TraceExportOptions): void {
  const { ledger, clusterId, readTask, allowedLogRoot, outputPath = null } = options;
  const causes = collectTaskCauses(ledger, clusterId);
  assertOutputDoesNotReplaceTaskLog(outputPath, allowedLogRoot, causes.keys());
  const destination = createExclusiveDestination(
    outputPath,
    options.stdout ?? process.stdout,
    'Trace'
  );
  const writer = createRecordWriter(destination);
  let ledgerMessages = 0;
  let taskOutputBytes = 0;
  const issues: string[] = [];
  try {
    writer.write({
      record_type: 'header',
      schema_version: TRACE_SCHEMA_VERSION,
      media_type: TRACE_MEDIA_TYPE,
      cluster_id: clusterId,
      chunk_bytes: TRACE_OUTPUT_CHUNK_BYTES,
    });
    forEachLedgerMessage(ledger, clusterId, (message) => {
      writer.write({ record_type: 'ledger_message', message });
      ledgerMessages += 1;
    });
    const ordered = [...causes.entries()].sort(([left], [right]) => compareText(left, right));
    for (const [taskId, cause] of ordered) {
      taskOutputBytes += streamTask({
        writer,
        taskId,
        cause,
        readTask,
        allowedLogRoot,
        issues,
      }).bytes;
    }
    issues.sort(compareText);
    writer.finish({
      record_type: 'footer',
      complete: issues.length === 0,
      ledger_messages: ledgerMessages,
      tasks: causes.size,
      task_output_bytes: taskOutputBytes,
      issues,
    });
  } finally {
    destination.close();
  }
}

export = {
  TRACE_OUTPUT_CHUNK_BYTES,
  collectTaskCauses,
  expectedLogPath,
  hasTerminalTaskStatus,
  logicalTaskRef,
  readTraceTask,
  streamClusterTraceExport,
};
