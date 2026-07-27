import chalk from 'chalk';
import { createRequire } from 'module';
import { getTask } from '../store.js';
import { spawnTask } from '../runner.js';

const require = createRequire(import.meta.url);
const { providerSupportsCapability } = require('../../lib/provider-names.js');

export function buildResumeTaskOptions(task) {
  if (!providerSupportsCapability(task.provider, 'sessionResume')) {
    throw new Error(`Provider ${task.provider} does not support safe session resume.`);
  }
  if (!task.sessionId) {
    throw new Error(
      `Task ${task.id} has no captured provider session ID; refusing cwd-wide continuation.`
    );
  }
  return {
    cwd: task.cwd,
    resume: task.sessionId,
    provider: task.provider,
  };
}

export async function resumeTask(taskId, newPrompt) {
  const task = getTask(taskId);

  if (!task) {
    console.log(chalk.red(`Task not found: ${taskId}`));
    process.exit(1);
  }

  if (task.status === 'running') {
    console.log(
      chalk.yellow(`Task is still running. Use 'zeroshot logs -f ${taskId}' to follow output.`)
    );
    return;
  }

  const prompt = newPrompt || 'Continue from where you left off. Complete the task.';

  console.log(chalk.dim(`Resuming task ${taskId}...`));
  console.log(chalk.dim(`Original prompt: ${task.prompt}`));
  console.log(chalk.dim(`Resume prompt: ${prompt}`));

  const newTask = await spawnTask(prompt, buildResumeTaskOptions(task));

  console.log(chalk.green(`\n✓ Resumed as new task: ${chalk.cyan(newTask.id)}`));
  console.log(chalk.dim(`  PID: ${newTask.pid}`));
  console.log(chalk.dim(`  Log: ${newTask.logFile}`));

  console.log(chalk.dim('\nCommands:'));
  console.log(chalk.dim(`  zeroshot logs -f ${newTask.id}   # Follow output`));
  console.log();

  return newTask;
}
