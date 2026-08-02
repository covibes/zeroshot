#!/usr/bin/env node

/**
 * Watcher process for the rpc-stdio invoke lane (OMP RPC v2). Runs detached from the parent,
 * drives the session over stdio via the shared runOmpRpcTask driver (task-lib/runner.js resolves
 * this script instead of watcher.js whenever the resolved provider's invoke.lane is 'rpc-stdio'),
 * and updates task status on completion. Foreground (contract-invoke.ts) and this detached watcher
 * both call runOmpRpcTask and therefore produce identical result semantics; the only difference is
 * that this watcher persists OmpRpcSpawnEvidence via updateTask before the prompt is written.
 */

import { appendFileSync } from 'fs';
import { getTask, updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import {
  completeWatcherFailure,
  completePendingWatcherCancellation,
  completeWatcherTask,
  createRpcWatcherOutputRuntime,
  terminateWatcherProvider,
} from './watcher-output-runtime.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  ABORT_GRACE_MS,
  EXIT_GRACE_MS,
  OMP_SUPPORTED_VERSION,
  runOmpRpcTask,
} = require('./provider-helper-runtime.js');

// No overall task timeout: detached tasks run until the provider produces a terminal frame,
// matching watcher.js's unbounded child.on('close') wait for every other lane.
const NO_TIMEOUT_MS = 2_147_483_647;

const [, , taskId, cwd, logFile, , configJson] = process.argv;
const config = configJson ? JSON.parse(configJson) : {};
const commandSpec = config.commandSpec || {};

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

const outputRuntime = createRpcWatcherOutputRuntime({ log });

let crashStarted = false;
let spawnEvidence = null;

function terminateOwnedProviderBoundary(exitObserved = false) {
  if (!spawnEvidence) return true;
  return terminateWatcherProvider(
    { pid: spawnEvidence.pid },
    { exitObserved, platform: process.platform }
  );
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

async function run() {
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
    return;
  }

  const controller = new AbortController();

  const result = await runOmpRpcTask(
    {
      commandSpec: { ...commandSpec, cwd: commandSpec.cwd || cwd },
      prompt: config.prompt || '',
      expectedVersion: OMP_SUPPORTED_VERSION,
      session: { kind: 'none' },
      signal: controller.signal,
      timeoutMs: NO_TIMEOUT_MS,
      abortGraceMs: ABORT_GRACE_MS,
      exitGraceMs: EXIT_GRACE_MS,
    },
    {
      onSpawn: async (evidence) => {
        spawnEvidence = evidence;
        await updateTask(taskId, {
          pid: evidence.pid,
          processGroupId: evidence.processGroupId,
          terminationStrategy: evidence.terminationStrategy,
        });
        if (getTask(taskId)?.cancelRequested) {
          crashStarted = true;
          controller.abort();
          await completePendingWatcherCancellation({
            taskId,
            getTask,
            commandCleanup,
            terminateProvider: terminateOwnedProviderBoundary,
            updateTask,
            emergencyLog,
          });
          process.exit(0);
        }
      },
      onEvent: (event) => {
        outputRuntime.logEvent(event);
        return Promise.resolve();
      },
      onSession: async () => {},
    }
  );

  if (crashStarted) return; // Cancelled mid-spawn; the onSpawn hook already exited the process.

  const completion = outputRuntime.complete(result);
  await completeWatcherTask({
    taskId,
    completion,
    commandCleanup,
    terminateProvider: () => terminateOwnedProviderBoundary(true),
    updateTask,
    emergencyLog,
  });
  process.exit(0);
}

run().catch((error) => {
  void crashWithError(error, 'run');
});
