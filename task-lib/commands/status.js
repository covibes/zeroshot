import chalk from 'chalk';
import { resolveEffectiveTaskStatus } from '../effective-status.js';
import { getTask } from '../store.js';

function nullable(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function preferredPrompt(task) {
  const fullPrompt = nullable(task.fullPrompt);
  if (fullPrompt !== null) return fullPrompt;
  return nullable(task.prompt);
}

function cleanupState(commandCleanup) {
  if (commandCleanup) return 'pending';
  return 'complete';
}

function projectStatus(task, effectiveStatus) {
  return {
    id: task.id,
    status: effectiveStatus.status,
    statusReason: effectiveStatus.reason,
    statusDetail: effectiveStatus.detail,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cwd: task.cwd,
    pid: nullable(task.pid),
    exitCode: nullable(task.exitCode),
    sessionId: nullable(task.sessionId),
    requestedResumeSessionId: nullable(task.requestedResumeSessionId),
    cleanup: cleanupState(task.commandCleanup),
    logFile: nullable(task.logFile),
    prompt: preferredPrompt(task),
    error: nullable(task.error),
    provider: nullable(task.provider),
    model: nullable(task.model),
    attachable: task.attachable === true,
  };
}

export function getStatusData(taskId, deps = {}) {
  const readTask = deps.getTask || getTask;
  const resolveStatus = deps.resolveEffectiveTaskStatus || resolveEffectiveTaskStatus;
  const task = readTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return projectStatus(task, resolveStatus(task));
}

function loadStatusOrExit(taskId, deps) {
  try {
    return getStatusData(taskId, deps);
  } catch (error) {
    console.log(chalk.red(error.message));
    process.exit(1);
    return null;
  }
}

function colorForStatus(status) {
  return (
    {
      running: chalk.green,
      completed: chalk.green,
      failed: chalk.red,
    }[status] || chalk.yellow
  );
}

function statusLabel(status) {
  if (status.statusDetail) return `${status.status} (${status.statusDetail})`;
  return status.status;
}

function displayOptional(value) {
  if (value === null) return 'N/A';
  return value;
}

function printRequestedSession(status) {
  if (!status.requestedResumeSessionId) return;
  console.log(`${chalk.dim('Requested:')}  ${status.requestedResumeSessionId}`);
}

function printError(status) {
  if (!status.error) return;
  console.log(`\n${chalk.red('Error:')} ${status.error}`);
}

export function showStatus(taskId, deps = {}) {
  const status = loadStatusOrExit(taskId, deps);
  if (!status) return;

  const statusColor = colorForStatus(status.status);
  console.log(chalk.bold(`\nTask: ${status.id}\n`));
  console.log(`${chalk.dim('Status:')}     ${statusColor(statusLabel(status))}`);
  console.log(`${chalk.dim('Created:')}    ${status.createdAt}`);
  console.log(`${chalk.dim('Updated:')}    ${status.updatedAt}`);
  console.log(`${chalk.dim('CWD:')}        ${status.cwd}`);
  console.log(`${chalk.dim('PID:')}        ${displayOptional(status.pid)}`);
  console.log(`${chalk.dim('Exit Code:')}  ${displayOptional(status.exitCode)}`);
  console.log(`${chalk.dim('Session:')}    ${displayOptional(status.sessionId)}`);
  console.log(`${chalk.dim('Cleanup:')}    ${status.cleanup}`);
  printRequestedSession(status);
  console.log(`${chalk.dim('Log File:')}   ${displayOptional(status.logFile)}`);

  console.log(`\n${chalk.dim('Prompt:')}`);
  console.log(displayOptional(status.prompt));
  printError(status);
  console.log();
}
