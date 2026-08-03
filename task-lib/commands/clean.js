import { unlinkSync, existsSync } from 'fs';
import chalk from 'chalk';
import { clearTaskCommandCleanup, loadTasks, removeTaskIfUnchanged } from '../store.js';
import { createCommandSpecCleanup } from '../command-spec-cleanup.js';
import { cleanupOmpSessionPartitionForTask } from '../omp-session-cleanup.js';

/**
 * Delete a task's OMP session partition directory as part of removing its row. Every ownership
 * state is cleaned here, including `provisional`: the row is going away, so leaving its partition
 * behind would orphan a directory nothing can ever reclaim. The shared OMP CAS blob root is never
 * touched. An unsafe/unresolvable path — or an ownership record that exists but cannot be read —
 * preserves the record, and therefore the whole task row, with an actionable warning.
 */
export function cleanUpOmpSessionPartition(task, warn) {
  return cleanupOmpSessionPartitionForTask(task, warn);
}

/**
 * The live-task retention boundary, evaluated before *any* cleanup side effect.
 *
 * A running task owns everything the row points at: its OMP session partition is the working
 * directory of a live provider process, and its command-cleanup receipt names paths that process
 * is still using. This used to be checked only inside the `commandCleanup` branch — i.e. after the
 * OMP partition had already been staged and recursively deleted — so `clean --all` could destroy a
 * live session's transcript for any task that happened not to carry a cleanup receipt.
 */
function isLiveTask(task) {
  return task.status === 'running';
}

/**
 * Remove one task row that `clean` selected, in the only order that is safe:
 * live-task check, then OMP partition, then command cleanup, then log file, then an owner-fenced
 * row delete.
 *
 * `task` is a snapshot from the caller's single `loadTasks()`, so the delete is conditional on the
 * row still matching it (see removeTaskIfUnchanged). A watcher update, a kill, or a resume's
 * ownership transfer landing mid-cleanup leaves the row in place rather than being reverted by a
 * whole-table rewrite.
 *
 * @returns {{removed: boolean, reason: string|null}} `reason` is a short retention label
 */
export function removeCleanedTask(task, { warn }) {
  if (isLiveTask(task)) {
    return { removed: false, reason: 'running' };
  }
  if (!cleanUpOmpSessionPartition(task, warn)) {
    return { removed: false, reason: 'OMP partition cleanup pending' };
  }

  let cleanupCleared = false;
  if (task.commandCleanup) {
    let recovered = false;
    try {
      const cleanup = createCommandSpecCleanup(task.commandCleanup, (cleanupPath, error) => {
        warn(`failed to clean up ${cleanupPath}: ${error.message}`);
      });
      recovered = cleanup.runSync();
    } catch (error) {
      warn(`failed to validate cleanup for task ${task.id}: ${error.message}`);
    }
    if (!recovered) {
      return { removed: false, reason: 'command cleanup pending' };
    }
    cleanupCleared = true;
  }

  if (task.logFile && existsSync(task.logFile)) {
    unlinkSync(task.logFile);
  }

  if (
    !removeTaskIfUnchanged(task.id, {
      status: task.status,
      ompSessionOwnership: task.ompSessionOwnership ?? null,
    })
  ) {
    // The row moved on under us. Its side effects are already done, so record the one piece of
    // durable state that would otherwise be retried forever, using a single-column write that
    // cannot clobber whatever the concurrent writer just persisted.
    if (cleanupCleared) clearTaskCommandCleanup(task.id, task.commandCleanup);
    return { removed: false, reason: 'the row changed while it was being cleaned' };
  }
  return { removed: true, reason: null };
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
    const { removed, reason } = removeCleanedTask(task, {
      warn: (message) => console.log(chalk.yellow(`Warning: ${message}`)),
    });
    if (!removed) {
      cleanupFailed = true;
      console.log(chalk.yellow(`  Retained: ${task.id} [${task.status}] (${reason})`));
      continue;
    }
    console.log(chalk.dim(`  Removed: ${task.id} [${task.status}]`));
    removedCount++;
  }

  // No whole-table rewrite here by design. Rows are deleted individually above, each fenced on the
  // snapshot it was validated against, so a concurrent watcher/kill/ownership-transfer write is
  // never reverted by cleanup finishing after it.
  console.log(chalk.green(`\n✓ Cleaned ${removedCount} task(s)`));
  if (cleanupFailed) process.exitCode = 1;
}
