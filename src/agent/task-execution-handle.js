/**
 * TaskExecutionHandle — first-class reentrant task-execution handle.
 *
 * Created BEFORE the provider process is spawned so cancellation is possible
 * even before a task ID or PID is known. Owns the process tree, tracks late
 * task-ID / PID assignment, and supports nested (child) executions that never
 * overwrite the parent's identity.
 */
class TaskExecutionHandle {
  constructor(agentId) {
    /** @type {string} Owning agent id (immutable). */
    this.agentId = agentId;
    /** @type {string|null} Zeroshot task id, assigned late by the spawn watcher. */
    this._taskId = null;
    /** @type {number|null} Real CLI process pid, assigned late by PID polling. */
    this._pid = null;
    /** @type {import('child_process').ChildProcess|null} Owned process tree. */
    this._proc = null;
    /** @type {boolean} */
    this._cancelled = false;
    this._cancelReason = null;
    /** @type {boolean} True once the owned process has exited. */
    this.settled = false;
    /** @type {Promise<void>|null} Resolves when the owned process exits. */
    this._settlePromise = null;
    this._resolveSettle = null;
  }

  // ── Immutable-ish identity accessors ──────────────────────────────────

  get taskId() {
    return this._taskId;
  }

  get pid() {
    return this._pid;
  }

  get isCancelled() {
    return this._cancelled;
  }

  get cancelReason() {
    return this._cancelReason;
  }

  // ── Late assignment (called by spawn / PID-polling) ───────────────────

  /** Assign the process handle so cancel() can reach it immediately. */
  attachProcess(proc) {
    this._proc = proc;
    this._settlePromise = new Promise((resolve) => {
      this._resolveSettle = resolve;
    });
    proc.once('close', () => {
      this.settled = true;
      if (this._resolveSettle) this._resolveSettle();
    });
    proc.once('error', () => {
      this.settled = true;
      if (this._resolveSettle) this._resolveSettle();
    });
    // If already cancelled before the process was attached, kill it now.
    if (this._cancelled) {
      this._killProcess();
    }
  }

  /** Assign the zeroshot task id (arrives after spawn watcher registers it). */
  assignTaskId(taskId) {
    this._taskId = taskId;
    // If cancelled while waiting for the id, clean up the late task.
    if (this._cancelled && taskId) {
      this._killProcess();
    }
  }

  /** Assign the real CLI process pid (arrives after PID polling). */
  assignPid(pid) {
    this._pid = pid;
  }

  // ── Cancellation ──────────────────────────────────────────────────────

  /**
   * Cancel this execution. Safe to call before taskId/pid/process are known.
   * @param {string} [reason]
   */
  cancel(reason = 'Task cancelled') {
    if (this._cancelled) return;
    this._cancelled = true;
    this._cancelReason = reason;
    this._killProcess();
  }

  /** Wait for the owned process tree to exit (no-op if no process). */
  async settle() {
    if (this._settlePromise) {
      await this._settlePromise;
    }
  }

  /** @private */
  _killProcess() {
    if (this._proc && !this.settled) {
      try {
        this._proc.kill('SIGTERM');
        // Force-kill after a grace period if still alive.
        const proc = this._proc;
        setTimeout(() => {
          if (!this.settled) {
            try {
              proc.kill('SIGKILL');
            } catch {
              // already dead
            }
          }
        }, 3000);
      } catch {
        // process already exited
      }
    }
  }
}

module.exports = { TaskExecutionHandle };
