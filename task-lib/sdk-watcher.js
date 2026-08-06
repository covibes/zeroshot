#!/usr/bin/env node

/**
 * Detached watcher for the pinned OMP SDK lane. The parent passes only runtime metadata and the
 * path to the owner-only request; prompt bytes remain in that private file and never enter argv.
 */
import { appendFileSync } from 'fs';
import { getTask, updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import {
  completePendingWatcherCancellation,
  completeWatcherFailure,
  completeWatcherTask,
} from './watcher-output-runtime.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { spawnOmpSdkProcess } = require('./omp-sdk-runtime.js');

const [, , taskId, , logFile, , configJson] = process.argv;
const config = configJson ? JSON.parse(configJson) : {};
const commandSpec = config.commandSpec || {};

function log(message) {
  appendFileSync(logFile, message);
}

function emergencyLog(message) {
  try {
    log(message);
  } catch {
    process.stderr.write(message);
  }
}

const commandCleanup = createCommandSpecCleanup(commandSpec, (cleanupPath, error) => {
  emergencyLog(`[${Date.now()}][CLEANUP] Failed to delete ${cleanupPath}: ${error.message}\n`);
});

let crashStarted = false;
let running = null;
let terminalResult = null;

function preparedInvocation() {
  if (!config.sdkPrepared || typeof config.sdkPrepared !== 'object') {
    throw new Error('OMP SDK watcher is missing its prepared invocation metadata.');
  }
  return { ...config.sdkPrepared, commandSpec };
}

function resultError(result) {
  if (result.terminal.type === 'error') {
    const { code, category } = result.terminal.frame.error;
    return `OMP SDK ${code} (${category})`;
  }
  if (result.terminal.event.success === false) {
    return result.terminal.event.error || 'OMP SDK turn failed';
  }
  if (result.cleanupAttestation.clean !== true) return 'OMP SDK cleanup was not attested';
  return result.exitCode === 0 ? null : `OMP SDK supervisor exited with code ${result.exitCode}`;
}

function completionFor(result) {
  const error = resultError(result);
  const cancelled =
    result.terminal.type === 'error' && result.terminal.frame.error.category === 'cancelled';
  const success = error === null;
  return {
    status: success ? 'completed' : cancelled ? 'killed' : 'failed',
    resolvedCode: success ? 0 : cancelled ? 143 : result.exitCode === 0 ? 1 : result.exitCode || 1,
    error,
  };
}

function logTerminal(result) {
  for (const frame of result.progress) log(`[${Date.now()}]${JSON.stringify(frame)}\n`);
  const terminal =
    result.terminal.type === 'result' ? result.terminal.event : result.terminal.frame;
  log(`[${Date.now()}]${JSON.stringify(terminal)}\n`);
  if (result.diagnosticStderr) {
    log(`[${Date.now()}][SDK-DIAGNOSTIC] ${result.diagnosticStderr}\n`);
  }
}

async function terminateOwnedProviderBoundary() {
  if (terminalResult) return terminalResult.cleanupAttestation.clean === true;
  if (!running) return true;
  running.cancel();
  try {
    terminalResult = await running.result;
    return terminalResult.cleanupAttestation.clean === true;
  } catch {
    return false;
  }
}

async function crashWithError(error, source) {
  if (crashStarted) return;
  crashStarted = true;
  await completeWatcherFailure({
    taskId,
    error,
    source,
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  });
  process.exit(1);
}

process.on('uncaughtException', (error) => {
  void crashWithError(error, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  void crashWithError(reason, 'unhandledRejection');
});

if (
  await completePendingWatcherCancellation({
    taskId,
    getTask,
    commandCleanup,
    terminateProvider: () => true,
    updateTask,
    emergencyLog,
  })
) {
  process.exit(0);
}

try {
  running = await spawnOmpSdkProcess(preparedInvocation());
  updateTask(taskId, {
    pid: running.pid,
    processGroupId: null,
    terminationStrategy: 'process',
  });
  if (getTask(taskId)?.cancelRequested) running.cancel();

  terminalResult = await running.result;
  logTerminal(terminalResult);
  await completeWatcherTask({
    taskId,
    completion: completionFor(terminalResult),
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  });
  process.exit(0);
} catch (error) {
  await crashWithError(error, 'OMP SDK watcher');
}
