/**
 * Single source of truth for "is this PID actually alive?"
 *
 * Previously this check was reimplemented separately in src/orchestrator.js
 * (_isProcessRunning) and lib/detached-startup.js (isProcessAlive), plus an
 * inline copy in _getActiveClustersForIssue. Four of those call sites agreed
 * on the answer; the resume() eligibility guard trusted persisted cluster
 * state instead of asking the OS, which is what let a dead-PID cluster be
 * simultaneously reported as "zombie" by status and "still running" by
 * resume. Consolidating avoids a sixth call site reintroducing that split.
 */

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function isProcessRunning(pid: unknown): boolean {
  if (!pid || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 doesn't kill, just checks if the process exists.
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // ESRCH = no such process, EPERM = process exists but we lack permission.
    return hasErrorCode(error, 'EPERM');
  }
}

export = { isProcessRunning };
