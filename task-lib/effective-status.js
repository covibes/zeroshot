import { isOwnedProcessTreeRunning } from './runner.js';

const DEFAULT_STARTUP_GRACE_MS = 30_000;

const STALE_REASON_LABELS = {
  invalid_process_ownership: 'invalid process ownership',
  process_died: 'process died',
  startup_timeout: 'provider startup timed out',
};

function runningStatus() {
  return { status: 'running', reason: null, detail: null, label: 'running' };
}

function staleStatus(reason) {
  const detail = STALE_REASON_LABELS[reason];
  return { status: 'stale', reason, detail, label: `stale (${detail})` };
}

function resolveStartupStatus(task, deps) {
  const createdAt = Date.parse(task.createdAt);
  const now = deps.now?.() ?? Date.now();
  const graceMs = deps.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  return Number.isFinite(createdAt) && now >= createdAt && now - createdAt <= graceMs
    ? runningStatus()
    : staleStatus('startup_timeout');
}

export function resolveEffectiveTaskStatus(task, deps = {}) {
  if (task.status !== 'running') {
    return { status: task.status, reason: null, detail: null, label: task.status };
  }
  // The durable row is written before the detached watcher can publish its owned provider PID.
  // Treat that startup window as live, but bound it so an abandoned watcher cannot look active
  // indefinitely.
  if (task.pid === null) return resolveStartupStatus(task, deps);

  const isRunning = deps.isOwnedProcessTreeRunning || isOwnedProcessTreeRunning;
  try {
    if (
      isRunning(task.pid, {
        processGroupId: task.processGroupId,
        terminationStrategy: task.terminationStrategy || 'process',
      })
    ) {
      return runningStatus();
    }
    return staleStatus('process_died');
  } catch {
    return staleStatus('invalid_process_ownership');
  }
}
