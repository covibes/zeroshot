import { unlinkSync, existsSync } from 'fs';
import chalk from 'chalk';
import { loadTasks, saveTasks } from '../store.js';
import { createCommandSpecCleanup } from '../command-spec-cleanup.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { deleteOmpSessionPartition } = require('../../src/omp-session-partition');

/**
 * Delete a task's OMP session partition directory (never the shared `.blobs` CAS root) when its
 * ownership is `committed` or `cleanup-required`. Returns true when it is now safe to remove the
 * task row; an unsafe/unresolvable path preserves the owner record (and therefore the whole task
 * row, the same retry-safety contract commandCleanup already uses) with an actionable warning.
 */
export function cleanUpOmpSessionPartition(task, warn) {
  const ownership = task.ompSessionOwnership;
  if (!ownership) return true;
  if (ownership.state !== 'committed' && ownership.state !== 'cleanup-required') return true;
  const { deleted, reason } = deleteOmpSessionPartition(
    ownership.storageRoot,
    ownership.partitionId
  );
  if (!deleted) {
    warn(`Task ${task.id}: retained OMP session partition ${ownership.partitionId} (${reason})`);
  }
  return deleted;
}

export function cleanTasks(options = {}) {
  const tasks = loadTasks();
  const taskList = Object.values(tasks);

  if (taskList.length === 0) {
    console.log(chalk.dim('No tasks to clean.'));
    return;
  }

  let cleanupFailed = false;
  let removedCount = 0;
  const toRemove = [];

  for (const task of taskList) {
    const shouldRemove =
      options.all ||
      (options.completed && task.status === 'completed') ||
      (options.failed &&
        (task.status === 'failed' || task.status === 'stale' || task.status === 'killed'));

    if (shouldRemove) {
      toRemove.push(task);
    }
  }

  if (toRemove.length === 0) {
    console.log(chalk.dim('No tasks match the criteria.'));
    return;
  }

  console.log(chalk.dim(`Removing ${toRemove.length} task(s)...\n`));

  for (const task of toRemove) {
    if (
      !cleanUpOmpSessionPartition(task, (message) =>
        console.log(chalk.yellow(`Warning: ${message}`))
      )
    ) {
      cleanupFailed = true;
      console.log(
        chalk.yellow(`  Retained: ${task.id} [${task.status}] (OMP partition cleanup pending)`)
      );
      continue;
    }
    if (task.commandCleanup) {
      if (task.status === 'running') {
        cleanupFailed = true;
        console.log(
          chalk.yellow(`  Retained: ${task.id} [running] (live command cleanup ownership)`)
        );
        continue;
      }
      let recovered = false;
      try {
        const cleanup = createCommandSpecCleanup(task.commandCleanup, (cleanupPath, error) => {
          console.log(chalk.yellow(`Warning: failed to clean up ${cleanupPath}: ${error.message}`));
        });
        recovered = cleanup.runSync();
      } catch (error) {
        console.log(
          chalk.yellow(`Warning: failed to validate cleanup for task ${task.id}: ${error.message}`)
        );
      }
      if (!recovered) {
        cleanupFailed = true;
        console.log(
          chalk.yellow(`  Retained: ${task.id} [${task.status}] (command cleanup pending)`)
        );
        continue;
      }
      task.commandCleanup = null;
    }
    if (task.logFile && existsSync(task.logFile)) {
      unlinkSync(task.logFile);
    }

    console.log(chalk.dim(`  Removed: ${task.id} [${task.status}]`));
    delete tasks[task.id];
    removedCount++;
  }

  saveTasks(tasks);

  console.log(chalk.green(`\n✓ Cleaned ${removedCount} task(s)`));
  if (cleanupFailed) process.exitCode = 1;
}
