import chalk from 'chalk';
import { getTask, updateTask } from '../store.js';
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
