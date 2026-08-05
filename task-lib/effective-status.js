import { isOwnedProcessTreeRunning } from './runner.js';

const STALE_REASON_LABELS = {
  invalid_process_ownership: 'invalid process ownership',
  process_died: 'process died',
};

export function resolveEffectiveTaskStatus(task, deps = {}) {
  if (task.status !== 'running') {
    return { status: task.status, reason: null, detail: null, label: task.status };
  }

  const isRunning = deps.isOwnedProcessTreeRunning || isOwnedProcessTreeRunning;
  try {
    if (
      isRunning(task.pid, {
        processGroupId: task.processGroupId,
        terminationStrategy: task.terminationStrategy || 'process',
      })
    ) {
      return { status: 'running', reason: null, detail: null, label: 'running' };
    }
    const detail = STALE_REASON_LABELS.process_died;
    return {
      status: 'stale',
      reason: 'process_died',
      detail,
      label: `stale (${detail})`,
    };
  } catch {
    const detail = STALE_REASON_LABELS.invalid_process_ownership;
    return {
      status: 'stale',
      reason: 'invalid_process_ownership',
      detail,
      label: `stale (${detail})`,
    };
  }
}
