import chalk from 'chalk';
import { getTask, requestTaskCancellation, updateTask } from '../store.js';
import { createCommandSpecCleanup } from '../command-spec-cleanup.js';
import { terminateProcess } from '../process-termination.js';
import { retireOmpOwnershipAtTerminalBoundary } from '../omp-session-ownership.js';

/**
 * Retire the task's OMP session ownership at a confirmed terminal boundary (killed / stale).
 *
 * A killed task's provisional partition claim would otherwise outlive the process that made it: no
 * watcher is left to reach `finalizeOmpOwnership`, and cleanup refuses to reclaim a partition any
 * row still claims provisionally, so the directory would be unreclaimable forever. Runs *before*
 * the terminal status write so no window exists where the row is terminal but still claiming.
 */
function retireOmpOwnershipForKilledTask(taskId) {
  retireOmpOwnershipAtTerminalBoundary(taskId, (error) => {
    console.log(
      chalk.yellow(
        `Warning: failed to retire the OMP session ownership of task ${taskId}: ${error.message}`
      )
    );
  });
}

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
  if (!task.commandCleanup) return true;
  const cleanupUpdate = await cleanupTerminatedTask(task);
  if (cleanupUpdate.commandCleanup === null) {
    updateTask(taskId, cleanupUpdate);
    console.log(chalk.green(`✓ Recovered pending command cleanup for task ${taskId}`));
    return true;
  }
  console.log(chalk.yellow(`Warning: command cleanup remains pending for task ${taskId}`));
  process.exitCode = 1;
  return false;
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
    if (Number.isInteger(current.pid) && current.pid > 0) {
      await killTaskCommand(taskId, options);
      const terminal = getTask(taskId);
      return Boolean(
        terminal && TERMINAL_STATUSES.has(terminal.status) && !terminal.commandCleanup
      );
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

  const platform = options.platform || process.platform;
  const terminate = options.terminateProcessFn || terminateProcess;
  const processOptions = { ...options };
  delete processOptions.platform;
  delete processOptions.terminateProcessFn;

  const terminationOptions = {
    ...processOptions,
    processGroupId: task.processGroupId,
    terminationStrategy: task.terminationStrategy || 'process',
  };

  const result = await terminate(task.pid, terminationOptions);

  if (result.terminated && result.alreadyDead) {
    if (platform === 'win32' && task.terminationStrategy === 'process-tree') {
      console.log(
        chalk.yellow(
          `Warning: Windows task root ${task.pid} is gone but descendant termination is unverified; preserving cleanup ownership`
        )
      );
      updateTask(taskId, {
        error: 'Windows process-tree termination could not be confirmed after root exit',
      });
      process.exitCode = 1;
      return;
    }
    console.log(chalk.yellow('Process already dead, updating status...'));
    const cleanupUpdate = await cleanupTerminatedTask(task);
    retireOmpOwnershipForKilledTask(taskId);
    updateTask(taskId, {
      status: 'stale',
      pid: null,
      processGroupId: null,
      error: 'Process died unexpectedly',
      cancelRequested: false,
      ...cleanupUpdate,
    });
    if (getTask(taskId)?.commandCleanup) {
      console.log(chalk.yellow(`Warning: command cleanup remains pending for task ${taskId}`));
      process.exitCode = 1;
    }
    return;
  }

  if (result.terminated) {
    const cleanupUpdate = await cleanupTerminatedTask(task);
    const suffix = result.escalated ? ' after SIGKILL escalation' : ' with SIGTERM';
    console.log(chalk.green(`✓ Killed task ${taskId} (PID: ${task.pid})${suffix}`));
    if (result.degraded) {
      console.log(chalk.yellow(`Warning: ${result.degradedReason}`));
    }
    retireOmpOwnershipForKilledTask(taskId);
    updateTask(taskId, {
      status: 'killed',
      pid: null,
      processGroupId: null,
      exitCode: result.escalated ? 137 : 143,
      error: result.escalated ? 'Killed by user after SIGKILL escalation' : 'Killed by user',
      cancelRequested: false,
      ...cleanupUpdate,
    });
    if (getTask(taskId)?.commandCleanup) {
      console.log(chalk.yellow(`Warning: command cleanup remains pending for task ${taskId}`));
      process.exitCode = 1;
    }
  } else {
    console.log(chalk.red(`Failed to kill task ${taskId}`));
    updateTask(taskId, {
      error: result.error || 'Process termination failed',
    });
    process.exitCode = 1;
  }
}
