#!/usr/bin/env node

/**
 * Watcher process - spawns and monitors a CLI process
 * Runs detached from parent, updates task status on completion
 */

import { spawn } from 'child_process';
import { appendFileSync } from 'fs';
import { updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import { terminateProcess } from './process-termination.js';
import {
  completeWatcherTask,
  createWatcherOutputRuntime,
  resolveWatcherCommand,
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

let child = spawn(command, finalArgs, {
  cwd: commandSpec.cwd || cwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
});

updateTask(taskId, {
  pid: child.pid,
  processGroupId: process.platform === 'win32' ? null : child.pid,
  terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
});

let crashStarted = false;
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
  const providerTerminal = await terminateOwnedProviderBoundary();
  const cleanupSucceeded = providerTerminal ? await commandCleanup.run() : false;
  try {
    await updateTask(taskId, {
      status: 'failed',
      pid: null,
      processGroupId: null,
      error: err.message,
      ...(cleanupSucceeded ? { commandCleanup: null } : {}),
    });
  } catch (updateError) {
    log(`[${Date.now()}][ERROR] Failed to update task status: ${updateError.message}\n`);
  }
  process.exit(1);
});

async function terminateOwnedProviderBoundary() {
  if (!child?.pid) return true;
  const result = await terminateProcess(child.pid, {
    processGroupId: process.platform === 'win32' ? null : child.pid,
    terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
  });
  return result.terminated;
}

async function crashWithError(error, source) {
  if (crashStarted) return;
  crashStarted = true;
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
  emergencyLog(`\n[${Date.now()}][CRASH] ${source}: ${errorMessage}\n`);
  const providerTerminal = await terminateOwnedProviderBoundary();
  let cleanupSucceeded = false;
  if (providerTerminal) {
    cleanupSucceeded = await commandCleanup.run();
  } else {
    emergencyLog(
      `[${Date.now()}][CRASH] Provider termination could not be confirmed; preserving command cleanup paths.\n`
    );
  }
  try {
    await updateTask(taskId, {
      status: 'failed',
      pid: null,
      processGroupId: null,
      error: `${source}: ${errorMessage}`,
      ...(cleanupSucceeded ? { commandCleanup: null } : {}),
    });
  } catch (updateError) {
    emergencyLog(`[${Date.now()}][CRASH] Failed to update task status: ${updateError.message}\n`);
  }
  process.exit(1);
}

process.on('uncaughtException', (error) => {
  void crashWithError(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  void crashWithError(reason, 'unhandledRejection');
});
