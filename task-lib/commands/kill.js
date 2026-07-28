import chalk from 'chalk';
import { getTask, requestTaskCancellation, updateTask } from '../store.js';
import { createCommandSpecCleanup } from '../command-spec-cleanup.js';
import { terminateProcess } from '../process-termination.js';

async function cleanupTerminatedTask(task) {
  if (!task.commandCleanup) return {};
  try {
    const cleanup = createCommandSpecCleanup(task.commandCleanup, (cleanupPath, error) => {
      console.log(chalk.yellow(`Warning: failed to clean up ${cleanupPath}: ${error.message}`));
    });
    return (await cleanup.run()) ? { commandCleanup: null } : {};
  } catch (error) {
    console.log(
      chalk.yellow(`Warning: failed to validate persisted command cleanup: ${error.message}`)
    );
    return {};
  }
}

async function retryTerminalTaskCleanup(taskId, task) {
  if (!task.commandCleanup) return;
  const cleanupUpdate = await cleanupTerminatedTask(task);
  if (cleanupUpdate.commandCleanup === null) {
    updateTask(taskId, cleanupUpdate);
    console.log(chalk.green(`✓ Recovered pending command cleanup for task ${taskId}`));
    return;
  }
  console.log(chalk.yellow(`Warning: command cleanup remains pending for task ${taskId}`));
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stale']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStartupCancellation(taskId, options) {
  const timeoutMs = options.startupCancelTimeoutMs ?? 8000;
  const pollMs = options.startupCancelPollMs ?? options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const current = getTask(taskId);
    if (!current) break;
    if (TERMINAL_STATUSES.has(current.status)) {
      await retryTerminalTaskCleanup(taskId, current);
      if (!getTask(taskId)?.commandCleanup) {
        console.log(chalk.green(`✓ Cancelled task ${taskId} before provider startup completed`));
        return true;
      }
    }
    await sleep(pollMs);
  }

  console.log(
    chalk.yellow(
      `Cancellation for task ${taskId} remains pending; provider termination and cleanup were not confirmed`
    )
  );
  process.exitCode = 1;
  return false;
}

export async function killTaskCommand(taskId, options = {}) {
  const task = getTask(taskId);

  if (!task) {
    console.log(chalk.red(`Task not found: ${taskId}`));
    process.exit(1);
  }

  if (task.status !== 'running') {
    await retryTerminalTaskCleanup(taskId, task);
    console.log(chalk.yellow(`Task is not running (status: ${task.status})`));
    return;
  }

  if (!Number.isInteger(task.pid) || task.pid <= 0) {
    requestTaskCancellation(taskId);
    console.log(
      chalk.yellow(
        `Task ${taskId} has not published a provider PID; persisted cancellation is pending`
      )
    );
    await waitForStartupCancellation(taskId, options);
    return;
  }

  const terminationOptions = {
    ...options,
    processGroupId: task.processGroupId,
    terminationStrategy: task.terminationStrategy || 'process',
  };

  const result = await terminateProcess(task.pid, terminationOptions);

  if (result.terminated && result.alreadyDead) {
    console.log(chalk.yellow('Process already dead, updating status...'));
    const cleanupUpdate = await cleanupTerminatedTask(task);
    updateTask(taskId, {
      status: 'stale',
      pid: null,
      processGroupId: null,
      error: 'Process died unexpectedly',
      cancelRequested: false,
      ...cleanupUpdate,
    });
    return;
  }

  if (result.terminated) {
    const cleanupUpdate = await cleanupTerminatedTask(task);
    const suffix = result.escalated ? ' after SIGKILL escalation' : ' with SIGTERM';
    console.log(chalk.green(`✓ Killed task ${taskId} (PID: ${task.pid})${suffix}`));
    if (result.degraded) {
      console.log(chalk.yellow(`Warning: ${result.degradedReason}`));
    }
    updateTask(taskId, {
      status: 'killed',
      pid: null,
      processGroupId: null,
      exitCode: result.escalated ? 137 : 143,
      error: result.escalated ? 'Killed by user after SIGKILL escalation' : 'Killed by user',
      cancelRequested: false,
      ...cleanupUpdate,
    });
  } else {
    console.log(chalk.red(`Failed to kill task ${taskId}`));
    updateTask(taskId, {
      error: result.error || 'Process termination failed',
    });
    process.exitCode = 1;
  }
}
