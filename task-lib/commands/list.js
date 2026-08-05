import chalk from 'chalk';
import { resolveEffectiveTaskStatus } from '../effective-status.js';
import { loadTasks } from '../store.js';

const DEFAULT_LIMIT = 20;

function selectTasks(options = {}, deps = {}) {
  const readTasks = deps.loadTasks || loadTasks;
  const resolveStatus = deps.resolveEffectiveTaskStatus || resolveEffectiveTaskStatus;
  const allTasks = Object.values(readTasks());
  const selected = allTasks
    .map((task) => ({ task, effectiveStatus: resolveStatus(task) }))
    .sort((left, right) => new Date(left.task.createdAt) - new Date(right.task.createdAt))
    .filter(({ effectiveStatus }) => !options.status || effectiveStatus.status === options.status)
    .slice(0, options.limit || DEFAULT_LIMIT);
  return { total: allTasks.length, selected };
}

function projectTask({ task, effectiveStatus }) {
  return {
    id: task.id,
    status: effectiveStatus.status,
    statusReason: effectiveStatus.reason,
    cwd: task.cwd,
    provider: task.provider || null,
    model: task.model || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    exitCode: task.exitCode ?? null,
    error: task.error || null,
    attachable: task.attachable === true,
  };
}

export function getTasksData(options = {}, deps = {}) {
  return selectTasks(options, deps).selected.map(projectTask);
}

export function listTasks(options = {}, deps = {}) {
  const { selected, total } = selectTasks(options, deps);

  if (total === 0) {
    console.log(chalk.dim('No tasks found.'));
    return;
  }

  if (options.verbose) {
    printVerboseTasks(selected, total);
  } else {
    printTaskTable(selected, total);
  }
}

function printVerboseTasks(selected, total) {
  console.log(chalk.bold(`\nTasks (${selected.length}/${total})\n`));

  for (const { task, effectiveStatus } of selected) {
    const statusColor = colorForStatus(effectiveStatus.status);
    const age = getAge(task.createdAt);
    const timestamp = new Date(task.createdAt).toLocaleString();

    const heading = `${statusColor('●')} ${chalk.cyan(task.id)}`;
    const status = statusColor(`[${effectiveStatus.status}]`);
    const timing = chalk.dim(age + ' • ' + timestamp);
    console.log(`${heading} ${status} ${timing}`);
    console.log(`  ${chalk.dim('CWD:')} ${task.cwd}`);
    console.log(`  ${chalk.dim('Prompt:')} ${task.prompt}`);
    if (task.pid && effectiveStatus.status === 'running') {
      console.log(`  ${chalk.dim('PID:')} ${task.pid}`);
    }
    if (task.error) {
      console.log(`  ${chalk.red('Error:')} ${task.error}`);
    }
    console.log();
  }
}

function printTaskTable(selected, total) {
  console.log(chalk.bold(`\n=== Tasks (${selected.length}/${total}) ===`));
  console.log(`${'ID'.padEnd(25)} ${'Status'.padEnd(12)} ${'Age'.padEnd(10)} CWD`);
  console.log('-'.repeat(100));

  for (const { task, effectiveStatus } of selected) {
    const statusColor = colorForStatus(effectiveStatus.status);
    const age = getAge(task.createdAt);
    const cwd = process.env.HOME ? task.cwd.replace(process.env.HOME, '~') : task.cwd;

    const id = chalk.cyan(task.id.padEnd(25));
    const status = statusColor(effectiveStatus.status.padEnd(12));
    const timing = chalk.dim(age.padEnd(10));
    console.log(`${id} ${status} ${timing} ${chalk.dim(cwd)}`);
  }
  console.log();
}

function colorForStatus(status) {
  return (
    {
      running: chalk.green,
      completed: chalk.green,
      failed: chalk.red,
      stale: chalk.yellow,
    }[status] || chalk.dim
  );
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
