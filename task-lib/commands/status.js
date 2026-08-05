import chalk from 'chalk';
import { getTask } from '../store.js';
import { resolveEffectiveTaskStatus } from '../effective-status.js';

export function showStatus(taskId) {
  const task = getTask(taskId);

  if (!task) {
    console.log(chalk.red(`Task not found: ${taskId}`));
    process.exit(1);
  }

  const effectiveStatus = resolveEffectiveTaskStatus(task);

  const statusColor =
    {
      running: chalk.green,
      completed: chalk.green,
      failed: chalk.red,
    }[effectiveStatus.status] || chalk.yellow;

  console.log(chalk.bold(`\nTask: ${task.id}\n`));
  console.log(`${chalk.dim('Status:')}     ${statusColor(effectiveStatus.label)}`);
  console.log(`${chalk.dim('Created:')}    ${task.createdAt}`);
  console.log(`${chalk.dim('Updated:')}    ${task.updatedAt}`);
  console.log(`${chalk.dim('CWD:')}        ${task.cwd}`);
  console.log(`${chalk.dim('PID:')}        ${task.pid || 'N/A'}`);
  console.log(`${chalk.dim('Exit Code:')}  ${task.exitCode ?? 'N/A'}`);
  console.log(`${chalk.dim('Session:')}    ${task.sessionId || 'N/A'}`);
  console.log(`${chalk.dim('Cleanup:')}    ${task.commandCleanup ? 'pending' : 'complete'}`);
  if (task.requestedResumeSessionId) {
    console.log(`${chalk.dim('Requested:')}  ${task.requestedResumeSessionId}`);
  }
  console.log(`${chalk.dim('Log File:')}   ${task.logFile}`);

  console.log(`\n${chalk.dim('Prompt:')}`);
  console.log(task.fullPrompt || task.prompt);

  if (task.error) {
    console.log(`\n${chalk.red('Error:')} ${task.error}`);
  }

  console.log();
}
