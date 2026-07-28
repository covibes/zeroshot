#!/usr/bin/env node

/**
 * Watcher process - spawns and monitors a CLI process
 * Runs detached from parent, updates task status on completion
 */

import { appendFileSync } from 'fs';
import { getTask, updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import {
  completeWatcherFailure,
  completePendingWatcherCancellation,
  completeWatcherTask,
  createWatcherOutputRuntime,
  resolveWatcherCommand,
  spawnWatcherProvider,
  terminateWatcherProvider,
} from './watcher-output-runtime.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeProviderName } = require('../lib/provider-names');

const [, , taskId, cwd, logFile, argsJson, configJson] = process.argv;
const args = JSON.parse(argsJson);
const config = configJson ? JSON.parse(configJson) : {};
const commandSpec = config.commandSpec || {
  binary: config.command || 'claude',
  args,
  env: config.env || {},
  cleanup: [],
};

function log(msg) {
  appendFileSync(logFile, msg);
}

function emergencyLog(msg) {
  try {
    log(msg);
  } catch {
    process.stderr.write(msg);
  }
}

const commandCleanup = createCommandSpecCleanup(commandSpec, (cleanupPath, error) => {
  emergencyLog(`[${Date.now()}][CLEANUP] Failed to delete ${cleanupPath}: ${error.message}\n`);
});

const { providerName, env, command, finalArgs } = resolveWatcherCommand(
  config,
  commandSpec,
  args,
  normalizeProviderName
);

if (
  await completePendingWatcherCancellation({
    taskId,
    getTask,
    commandCleanup,
    terminateProvider: async () => true,
    updateTask,
    emergencyLog,
  })
) {
  process.exit(0);
}

let crashStarted = false;
let child = spawnWatcherProvider(command, finalArgs, {
  cwd: commandSpec.cwd || cwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});

updateTask(taskId, {
  pid: child.pid,
  processGroupId: process.platform === 'win32' ? null : child.pid,
  terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
});

if (
  await completePendingWatcherCancellation({
    taskId,
    getTask,
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  })
) {
  crashStarted = true;
  process.exit(0);
}


let stdoutBuffer = '';
let stderrBuffer = '';

function stopProviderAfterFatalOutput() {
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore - process may already be dead
  }

  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore - process may already be dead
      }
    }
  }, 5000);
}

const outputRuntime = createWatcherOutputRuntime({
  config,
  providerName,
  log,
  stopProvider: stopProviderAfterFatalOutput,
});

child.stdout.on('data', (data) => {
  stdoutBuffer = outputRuntime.consumeOutput(stdoutBuffer, data);
});

child.stderr.on('data', (data) => {
  stderrBuffer = outputRuntime.consumeStderr(stderrBuffer, data);
});

child.on('close', async (code, signal) => {
  if (crashStarted) return;
  const completion = outputRuntime.complete({
    code,
    signal,
    outputBuffer: stdoutBuffer,
    stderrBuffer,
  });
  await completeWatcherTask({
    taskId,
    completion,
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  });
  process.exit(0);
});

child.on('error', async (err) => {
  crashStarted = true;
  log(`\nError: ${err.message}\n`);
  await completeWatcherTask({
    taskId,
    completion: { status: 'failed', resolvedCode: 1, error: err.message },
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  });
  process.exit(1);
});

function terminateOwnedProviderBoundary() {
  return terminateWatcherProvider(child);
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
