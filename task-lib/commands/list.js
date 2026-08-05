import chalk from 'chalk';
import { loadTasks } from '../store.js';
import { resolveEffectiveTaskStatus } from '../effective-status.js';

export function listTasks(options = {}) {
  const tasks = loadTasks();
  const taskList = Object.values(tasks);

  if (taskList.length === 0) {
    console.log(chalk.dim('No tasks found.'));
    return;
  }

  // Sort by creation date, oldest first (chronological)
  taskList.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Filter by status if specified
  let filtered = taskList;
  if (options.status) {
    filtered = taskList.filter((t) => t.status === options.status);
  }

  // Limit results
  const limit = options.limit || 20;
  filtered = filtered.slice(0, limit);

  // Table format (default) or verbose format
  if (options.verbose) {
    // Verbose format (old behavior)
    console.log(chalk.bold(`\nTasks (${filtered.length}/${taskList.length})\n`));

    for (const task of filtered) {
      const { status } = resolveEffectiveTaskStatus(task);

      const statusColor =
        {
          running: chalk.green,
          completed: chalk.green,
          failed: chalk.red,
          stale: chalk.yellow,
        }[status] || chalk.dim;

      const age = getAge(task.createdAt);
      const timestamp = new Date(task.createdAt).toLocaleString();

      console.log(
        `${statusColor('●')} ${chalk.cyan(task.id)} ${statusColor(`[${status}]`)} ${chalk.dim(age + ' • ' + timestamp)}`
      );
      console.log(`  ${chalk.dim('CWD:')} ${task.cwd}`);
      console.log(`  ${chalk.dim('Prompt:')} ${task.prompt}`);
      if (task.pid && status === 'running') {
        console.log(`  ${chalk.dim('PID:')} ${task.pid}`);
      }
      if (task.error) {
        console.log(`  ${chalk.red('Error:')} ${task.error}`);
      }
      console.log();
    }
  } else {
    // Table format (clean, default)
    console.log(chalk.bold(`\n=== Tasks (${filtered.length}/${taskList.length}) ===`));
    console.log(`${'ID'.padEnd(25)} ${'Status'.padEnd(12)} ${'Age'.padEnd(10)} CWD`);
    console.log('-'.repeat(100));

    for (const task of filtered) {
      const { status } = resolveEffectiveTaskStatus(task);

      const statusColor =
        {
          running: chalk.green,
          completed: chalk.green,
          failed: chalk.red,
          stale: chalk.yellow,
        }[status] || chalk.dim;

      const age = getAge(task.createdAt);
      const cwd = task.cwd.replace(process.env.HOME, '~');

      console.log(
        `${chalk.cyan(task.id.padEnd(25))} ${statusColor(status.padEnd(12))} ${chalk.dim(age.padEnd(10))} ${chalk.dim(cwd)}`
      );
    }
    console.log();
  }
}

function getAge(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}
