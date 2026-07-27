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
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
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

const providerName = normalizeProviderName(config.provider || 'claude');
const enableRecovery = supportsProviderStructuredOutputRecovery(providerName);

const env = { ...process.env, ...(commandSpec.env || {}) };
const command = commandSpec.binary;
const finalArgs = [...(commandSpec.args || args)];

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

const silentJsonMode =
  config.outputFormat === 'json' &&
  config.jsonSchema &&
  config.silentJsonOutput &&
  supportsProviderStructuredOutputRecovery(providerName);

let finalResultJson = null;
let streamingModeError = null;
let fatalError = null;
let crashStarted = false;

let stdoutBuffer = '';
let stderrBuffer = '';

function splitBufferLines(buffer, chunk) {
  const nextBuffer = buffer + chunk;
  const lines = nextBuffer.split('\n');
  const remaining = lines.pop() || '';
  return { lines, remaining };
}

function maybeHandleFatalError(line, timestamp) {
  if (fatalError) {
    return false;
  }

  const detected = detectProviderFatalError(providerName, line);
  if (!detected) {
    return false;
  }

  fatalError = detected;

  if (silentJsonMode) {
    log(`[${timestamp}]${line}\n`);
  }
  log(`[${timestamp}][FATAL] ${detected}\n`);

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

  return true;
}

function captureStreamingError(line, timestamp) {
  const detectedError = detectProviderStreamingModeError(providerName, line);
  if (!detectedError) {
    return false;
  }

  streamingModeError = { ...detectedError, timestamp };
  return true;
}

function maybeCaptureStructuredOutput(line) {
  try {
    const json = JSON.parse(line);
    if (json.structured_output) {
      finalResultJson = line;
    }
  } catch {
    // Not JSON, skip
  }
}

function handleSilentJsonLines(lines, timestamp) {
  for (const line of lines) {
    if (!line.trim()) continue;
    maybeHandleFatalError(line, timestamp);
    if (captureStreamingError(line, timestamp)) {
      continue;
    }
    maybeCaptureStructuredOutput(line);
  }
}

function handleStreamingLines(lines, timestamp) {
  for (const line of lines) {
    maybeHandleFatalError(line, timestamp);
    if (captureStreamingError(line, timestamp)) {
      continue;
    }
    log(`[${timestamp}]${line}\n`);
  }
}

function flushStdoutBuffer(timestamp) {
  if (!stdoutBuffer.trim()) {
    return;
  }

  if (!enableRecovery) {
    if (!silentJsonMode) {
      log(`[${timestamp}]${stdoutBuffer}\n`);
    }
    return;
  }

  maybeHandleFatalError(stdoutBuffer, timestamp);
  if (captureStreamingError(stdoutBuffer, timestamp)) {
    return;
  }

  if (silentJsonMode) {
    maybeCaptureStructuredOutput(stdoutBuffer);
    return;
  }

  log(`[${timestamp}]${stdoutBuffer}\n`);
}

function flushStderrBuffer(timestamp) {
  if (stderrBuffer.trim()) {
    maybeHandleFatalError(stderrBuffer, timestamp);
    log(`[${timestamp}]${stderrBuffer}\n`);
  }
}

function attemptRecovery(code, timestamp) {
  if (!(code !== 0 && streamingModeError?.sessionId)) {
    return null;
  }

  const recovered = recoverProviderStructuredOutput(providerName, streamingModeError.sessionId);
  if (recovered?.payload) {
    const recoveredLine = JSON.stringify(recovered.payload);
    if (silentJsonMode) {
      finalResultJson = recoveredLine;
    } else {
      log(`[${timestamp}]${recoveredLine}\n`);
    }
  } else if (streamingModeError.line) {
    if (silentJsonMode) {
      log(streamingModeError.line + '\n');
    } else {
      log(`[${streamingModeError.timestamp}]${streamingModeError.line}\n`);
    }
  }

  return recovered;
}

function writeCompletionFooter(code, signal) {
  if (config.outputFormat === 'json') {
    return;
  }

  log(`\n${'='.repeat(50)}\n`);
  log(`Finished: ${new Date().toISOString()}\n`);
  log(`Exit code: ${code}, Signal: ${signal}\n`);
}

child.stdout.on('data', (data) => {
  const chunk = data.toString();
  const timestamp = Date.now();

  const { lines, remaining } = splitBufferLines(stdoutBuffer, chunk);
  stdoutBuffer = remaining;

  if (silentJsonMode) {
    handleSilentJsonLines(lines, timestamp);
  } else {
    handleStreamingLines(lines, timestamp);
  }
});

child.stderr.on('data', (data) => {
  const chunk = data.toString();
  const timestamp = Date.now();

  const { lines, remaining } = splitBufferLines(stderrBuffer, chunk);
  stderrBuffer = remaining;

  for (const line of lines) {
    log(`[${timestamp}]${line}\n`);
  }
});

child.on('close', async (code, signal) => {
  if (crashStarted) return;
  const timestamp = Date.now();

  flushStdoutBuffer(timestamp);
  flushStderrBuffer(timestamp);

  const recovered = attemptRecovery(code, timestamp);

  if (silentJsonMode && finalResultJson) {
    log(finalResultJson + '\n');
  }

  writeCompletionFooter(code, signal);
  const cleanupSucceeded = await commandCleanup.run();

  const resolvedCode = fatalError ? 1 : recovered?.payload ? 0 : code;
  const status = resolvedCode === 0 ? 'completed' : 'failed';
  try {
    await updateTask(taskId, {
      status,
      pid: null,
      processGroupId: null,
      exitCode: resolvedCode,
      error: fatalError || (resolvedCode !== 0 && signal ? `Killed by ${signal}` : null),
      ...(cleanupSucceeded ? { commandCleanup: null } : {}),
    });
  } catch (updateError) {
    log(`[${Date.now()}][ERROR] Failed to update task status: ${updateError.message}\n`);
  }
  process.exit(0);
});

child.on('error', async (err) => {
  log(`\nError: ${err.message}\n`);
  const cleanupSucceeded = commandCleanup.runSync();
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

async function terminateProviderAfterWatcherCrash() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
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
  const providerTerminal = await terminateProviderAfterWatcherCrash();
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
