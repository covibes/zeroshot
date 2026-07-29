function isTerminationConfirmed(termination) {
  return termination?.forced !== false || termination?.alreadyTerminal === true;
}

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
    /** @type {string|null} Zeroshot task id, assigned once after registration. */
    this._taskId = null;
    /** @type {number|null} Real CLI process pid, assigned once after registration. */
    this._pid = null;
    /** @type {import('child_process').ChildProcess|null} Launch wrapper process. */
    this._proc = null;
    this._cancelled = false;
    this._cancelReason = null;
    this._cancelDetails = {};
    this._cancelAction = null;
    this._failClosedAction = null;
    this._failClosedError = null;
    this._invokedCancelActions = new Set();
    this._cancelActionPromises = [];
    this._executionFinished = false;
    this._retainOwnership = false;
    this.settled = false;
    this._resolveSettle = null;
    this._settlePromise = new Promise((resolve) => {
      this._resolveSettle = resolve;
    });
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._killTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._deadlineTimer = null;
  }

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

  get cancelDetails() {
    return this._cancelDetails;
  }

  attachProcess(proc) {
    this._proc = proc;
    const clearWrapperKill = () => this._clearKillTimer();
    proc.once('close', clearWrapperKill);
    proc.once('error', clearWrapperKill);
    if (this._cancelled) {
      this._killProcess();
    }
  }

  assignTaskId(taskId) {
    if (this._taskId && this._taskId !== taskId) {
      throw new Error(`Nested execution task ID changed from ${this._taskId} to ${taskId}`);
    }
    this._taskId = taskId;
    if (this._cancelled) {
      this._killProcess();
      this._invokeCancelAction();
    }
  }

  assignPid(pid) {
    if (this._pid && this._pid !== pid) {
      throw new Error(`Nested execution PID changed from ${this._pid} to ${pid}`);
    }
    this._pid = pid;
  }

  setCancelAction(action) {
    const previousAction = this._cancelAction;
    this._cancelAction = action;
    if (this._cancelled) {
      this._invokeCancelAction();
    }
    return previousAction;
  }

  setFailClosedAction(action) {
    this._failClosedAction = action;
    if (this._failClosedError) {
      action(this._failClosedError);
    }
  }

  failClosed(error) {
    if (this.settled || this._failClosedError) return false;
    this._retainOwnership = true;
    this._failClosedError = error;
    if (!error.taskId && this._taskId) {
      error.taskId = this._taskId;
    }
    if (this._failClosedAction) {
      this._failClosedAction(error);
    }
    return true;
  }

  cancel(reason = 'Task cancelled', details = {}) {
    if (!this._cancelled) {
      this._cancelled = true;
      this._cancelReason = reason;
      this._cancelDetails = details;
    }
    this._clearDeadlineTimer();
    this._killProcess();
    this._invokeCancelAction();
    return this.waitForCancellation();
  }

  async waitForCancellation() {
    let observedCount = -1;
    let results = [];
    try {
      while (observedCount !== this._cancelActionPromises.length) {
        observedCount = this._cancelActionPromises.length;
        results = await Promise.all(this._cancelActionPromises);
      }
    } catch (error) {
      this._retainOwnership = true;
      this._invokedCancelActions.delete(this._cancelAction);
      this._cancelActionPromises = [];
      throw error;
    }
    const termination = results.at(-1);
    if (!isTerminationConfirmed(termination)) {
      this._retainOwnership = true;
      this._invokedCancelActions.delete(this._cancelAction);
      this._cancelActionPromises = [];
    } else if (this._executionFinished) {
      this._retainOwnership = false;
      this.markSettled();
    }
    return termination;
  }

  armDeadline(timeoutMs) {
    if (timeoutMs <= 0 || this.settled) return;
    this._clearDeadlineTimer();
    this._deadlineTimer = setTimeout(() => {
      this._deadlineTimer = null;
      this.cancel(`Nested task timed out after ${timeoutMs}ms`, {
        code: 'AGENT_TASK_TIMEOUT',
      }).catch(() => {
        // The execution owner observes cancellation failure while settling.
      });
    }, timeoutMs);
  }

  retainOwnership() {
    this._retainOwnership = true;
  }

  finishExecution() {
    this._executionFinished = true;
    if (!this._retainOwnership) {
      this.markSettled();
    }
  }

  markSettled() {
    if (this.settled) return;
    this.settled = true;
    this._clearKillTimer();
    this._clearDeadlineTimer();
    this._resolveSettle();
  }

  async settle() {
    await this._settlePromise;
  }

  _invokeCancelAction() {
    const action = this._cancelAction;
    if (!action || this._invokedCancelActions.has(action)) return;
    this._invokedCancelActions.add(action);
    const cancellation = Promise.resolve().then(() =>
      action(this._cancelReason, this._cancelDetails)
    );
    this._cancelActionPromises.push(cancellation);
  }

  _clearDeadlineTimer() {
    if (this._deadlineTimer) {
      clearTimeout(this._deadlineTimer);
      this._deadlineTimer = null;
    }
  }

  _clearKillTimer() {
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
  }

  _killProcess() {
    if (!this._proc || this.settled) return;
    try {
      this._proc.kill('SIGTERM');
      const proc = this._proc;
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        if (!this.settled) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process already exited.
          }
        }
      }, 3000);
    } catch {
      // Process already exited.
    }
  }
}

class NestedExecutionRegistry {
  constructor(agentId) {
    this.agentId = agentId;
    this._handles = new Set();
    this._cancellation = null;
  }

  get size() {
    return this._handles.size;
  }

  get hasActive() {
    return this._handles.size > 0;
  }

  get activeTaskIds() {
    return [...this._handles].map((handle) => handle.taskId).filter(Boolean);
  }

  register(handle) {
    if (this._cancellation) {
      const error = new Error(this._cancellation.reason);
      error.code = this._cancellation.details.code || 'REFORMAT_CANCELLED';
      error.nestedExecutionCancellation = true;
      error.nestedExecutionLifecycle = true;
      throw error;
    }
    if (!(handle instanceof TaskExecutionHandle)) {
      throw new TypeError('Nested execution registry accepts TaskExecutionHandle instances only');
    }
    if (handle.agentId !== this.agentId) {
      throw new Error(
        `Nested execution owner mismatch: registry ${this.agentId}, handle ${handle.agentId}`
      );
    }
    this._handles.add(handle);
    return handle;
  }

  unregister(handle) {
    if (!handle.settled) {
      throw new Error('Cannot unregister a nested execution before settlement');
    }
    this._handles.delete(handle);
  }

  failClosed(error) {
    let dispatched = false;
    for (const handle of this._handles) {
      dispatched = handle.failClosed(error) || dispatched;
    }
    return dispatched;
  }

  async cancelAll(reason = 'Task cancelled', details = {}) {
    this._cancellation = { reason, details };
    try {
      const handles = [...this._handles];
      const terminations = await Promise.all(
        handles.map(async (handle) => {
          const termination = await handle.cancel(reason, details);
          if (isTerminationConfirmed(termination)) {
            await handle.settle();
            this.unregister(handle);
          }
          return termination;
        })
      );
      const failed = terminations.find(
        (termination) => !isTerminationConfirmed(termination)
      );
      return failed || { forced: true, nested: terminations };
    } finally {
      this._cancellation = null;
    }
  }
}

function getNestedExecutionRegistry(agent) {
  if (!agent.nestedExecutions) {
    agent.nestedExecutions = new NestedExecutionRegistry(agent.id);
  }
  return agent.nestedExecutions;
}

module.exports = {
  getNestedExecutionRegistry,
  NestedExecutionRegistry,
  TaskExecutionHandle,
};
