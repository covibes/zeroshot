import path = require('path');
import { isRecord, nullableString } from './export-stream';

const TASK_LIFECYCLE_EVENTS = new Set([
  'TASK_ID_ASSIGNED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
]);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stale', 'cancelled']);

export interface ClusterLedger {
  iterateAll(clusterId: string): Iterable<unknown>;
}

export interface TraceTask {
  id?: unknown;
  fullPrompt?: unknown;
  prompt?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  exitCode?: unknown;
  provider?: unknown;
  model?: unknown;
  logFile?: unknown;
}

export interface TaskCause {
  agentIds: Set<string>;
}

export interface TraceTaskRead {
  issue: string | null;
  task: TraceTask | null;
}

export function hasTerminalTaskStatus(task: TraceTask): boolean {
  const status = nullableString(task.status);
  return status !== null && TERMINAL_TASK_STATUSES.has(status);
}

export function forEachLedgerMessage(
  ledger: ClusterLedger,
  clusterId: string,
  consume: (message: unknown) => void
): void {
  for (const message of ledger.iterateAll(clusterId)) consume(message);
}

function recordData(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || !isRecord(message.content)) return null;
  return isRecord(message.content.data) ? message.content.data : null;
}

function messageSender(message: unknown, data: Record<string, unknown>): string | null {
  const declaredAgent = nullableString(data.agent);
  if (declaredAgent) return declaredAgent;
  if (!isRecord(message)) return null;
  return nullableString(message.sender) || null;
}

function isTaskEvidenceMessage(message: unknown, data: Record<string, unknown>): boolean {
  if (!isRecord(message)) return false;
  if (message.topic === 'AGENT_OUTPUT') return true;
  return (
    message.topic === 'AGENT_LIFECYCLE' &&
    TASK_LIFECYCLE_EVENTS.has(nullableString(data.event) || '')
  );
}

export function collectTaskCauses(
  ledger: ClusterLedger,
  clusterId: string
): Map<string, TaskCause> {
  const causes = new Map<string, TaskCause>();
  forEachLedgerMessage(ledger, clusterId, (message) => {
    const data = recordData(message);
    if (!data || !isTaskEvidenceMessage(message, data)) return;
    const taskId = nullableString(data.taskId);
    if (!taskId) return;
    const cause = causes.get(taskId) || { agentIds: new Set<string>() };
    const sender = messageSender(message, data);
    if (sender) cause.agentIds.add(sender);
    causes.set(taskId, cause);
  });
  return causes;
}

export function logicalTaskRef(taskId: string, leaf: 'prompt' | 'output'): string {
  return `zeroshot-trace://task/${encodeURIComponent(taskId)}/${leaf}`;
}

export function expectedLogPath(allowedLogRoot: string, taskId: string): string | null {
  const resolvedRoot = path.resolve(allowedLogRoot);
  const expected = path.resolve(resolvedRoot, `${taskId}.log`);
  return path.dirname(expected) === resolvedRoot ? expected : null;
}

export function readTraceTask(
  taskId: string,
  readTask: (taskId: string) => TraceTask | null
): TraceTaskRead {
  let task: TraceTask | null;
  try {
    task = readTask(taskId);
  } catch {
    return { task: null, issue: `task:${taskId}:task_row_unreadable` };
  }
  if (!task) return { task: null, issue: `task:${taskId}:task_row_missing` };
  if (task.id !== undefined && task.id !== taskId) {
    return { task: null, issue: `task:${taskId}:task_row_identity_mismatch` };
  }
  return { task, issue: null };
}
