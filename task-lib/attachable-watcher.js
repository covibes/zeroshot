#!/usr/bin/env node

/**
 * Attachable Watcher - spawns a CLI process with PTY for attach/detach support
 * Runs detached from parent, provides Unix socket for attach clients.
 */

import { appendFileSync } from 'fs';
import { updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import { terminateProcess } from './process-termination.js';
import * as watcherOutputRuntime from './watcher-output-runtime.js';
import { createRequire } from 'module';

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 CRITICAL: Global error handlers - MUST be installed BEFORE any async ops
// Without these, uncaught errors cause SILENT process death (no logs, no status)
// ═══════════════════════════════════════════════════════════════════════════

const [, , taskIdArg, cwdArg, logFileArg, argsJsonArg, configJsonArg] = process.argv;
let commandCleanup = null;
let crashStarted = false;
let server = null;

function emergencyLog(msg) {
  if (logFileArg) {
    try {
      appendFileSync(logFileArg, msg);
    } catch {
      process.stderr.write(msg);
    }
  } else {
    process.stderr.write(msg);
  }
}

async function stopAttachableProvider() {
  const pid = server?.pid;
  if (!pid) return true;
  const result = await terminateProcess(pid, {
    processGroupId: process.platform === 'win32' ? null : pid,
    terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
  });
  return result.terminated;
}

async function failWatcher(error, source) {
  if (crashStarted) return;
  crashStarted = true;
  const timestamp = Date.now();
  const errorMsg = error instanceof Error ? error.stack || error.message : String(error);

  emergencyLog(`\n[${timestamp}][CRASH] ${source}: ${errorMsg}\n`);
  const providerTerminal = await stopAttachableProvider();
  let cleanupSucceeded = false;
  if (providerTerminal) {
    cleanupSucceeded = commandCleanup ? await commandCleanup.run() : true;
  } else {
    emergencyLog(
      `[${timestamp}][CRASH] Provider termination could not be confirmed; preserving command cleanup paths.\n`
    );
  }

  if (taskIdArg) {
    try {
      await updateTask(taskIdArg, {
        status: 'failed',
        pid: null,
        processGroupId: null,
        error: `${source}: ${errorMsg}`,
        socketPath: null,
        ...(cleanupSucceeded ? { commandCleanup: null } : {}),
      });
    } catch (updateError) {
      emergencyLog(`[${timestamp}][CRASH] Failed to update task status: ${updateError.message}\n`);
    }
  }

  process.exit(1);
}

process.on('uncaughtException', (error) => {
  void failWatcher(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  void failWatcher(reason, 'unhandledRejection');
});

const require = createRequire(import.meta.url);
const { AttachServer } = require('../src/attach');
const { getTaskSocketPath } = require('../src/attach/socket-paths');
const { normalizeProviderName } = require('../lib/provider-names');

const taskId = taskIdArg;
const cwd = cwdArg;
const logFile = logFileArg;
const args = JSON.parse(argsJsonArg);
const config = configJsonArg ? JSON.parse(configJsonArg) : {};
const commandSpec = config.commandSpec || {
  binary: config.command || 'claude',
  args,
  env: config.env || {},
  cleanup: [],
};
commandCleanup = createCommandSpecCleanup(commandSpec, (cleanupPath, error) => {
  emergencyLog(`[${Date.now()}][CLEANUP] Failed to delete ${cleanupPath}: ${error.message}\n`);
});

const socketPath = getTaskSocketPath(taskId);

function log(msg) {
  appendFileSync(logFile, msg);
}

const { providerName, env, command, finalArgs } = watcherOutputRuntime.resolveWatcherCommand(
  config,
  commandSpec,
  args,
  normalizeProviderName
);
let outputBuffer = '';

function stopProviderAfterFatalOutput(timestamp) {
  if (server) {
    server.stop('SIGTERM').catch((error) => {
      log(`[${timestamp}][FATAL] Attach server stop failed: ${error.message}\n`);
    });
  }
}

const outputRuntime = watcherOutputRuntime.createWatcherOutputRuntime({
  config,
  providerName,
  log,
  stopProvider: stopProviderAfterFatalOutput,
});

server = new AttachServer({
  id: taskId,
  socketPath,
  command,
  args: finalArgs,
  cwd: commandSpec.cwd || cwd,
  env,
  cols: 120,
  rows: 30,
});

server.on('output', (data) => {
  outputBuffer = outputRuntime.consumeOutput(outputBuffer, data);
});

server.on('exit', async ({ exitCode, signal }) => {
  if (crashStarted) return;
  const completion = outputRuntime.complete({ code: exitCode, signal, outputBuffer });
  await watcherOutputRuntime.completeWatcherTask({
    taskId,
    completion,
    commandCleanup,
    terminateProvider: stopAttachableProvider,
    updateTask,
    emergencyLog,
    terminalUpdates: { socketPath: null },
  });

  setTimeout(() => {
    process.exit(0);
  }, 500);
});

server.on('error', async (err) => {
  await failWatcher(err, 'attach server error');
});

server.on('clientAttach', ({ clientId }) => {
  log(`[${Date.now()}][ATTACH] Client attached: ${clientId.slice(0, 8)}...\n`);
});

server.on('clientDetach', ({ clientId }) => {
  log(`[${Date.now()}][DETACH] Client detached: ${clientId.slice(0, 8)}...\n`);
});

try {
  await server.start();

  updateTask(taskId, {
    pid: server.pid,
    socketPath,
    attachable: true,
    processGroupId: process.platform === 'win32' ? null : server.pid,
    terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
  });

  log(`[${Date.now()}][SYSTEM] Started with PTY (attachable)\n`);
  log(`[${Date.now()}][SYSTEM] Socket: ${socketPath}\n`);
  log(`[${Date.now()}][SYSTEM] PID: ${server.pid}\n`);
} catch (err) {
  await failWatcher(err, 'attach server start');
}

process.on('SIGTERM', async () => {
  log(`[${Date.now()}][SYSTEM] Received SIGTERM, stopping...\n`);
  await stopAttachableProvider();
});

process.on('SIGINT', async () => {
  log(`[${Date.now()}][SYSTEM] Received SIGINT, stopping...\n`);
  await stopAttachableProvider();
});
