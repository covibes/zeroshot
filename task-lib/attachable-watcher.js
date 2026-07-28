#!/usr/bin/env node

/**
 * Attachable Watcher - spawns a CLI process with PTY for attach/detach support
 * Runs detached from parent, provides Unix socket for attach clients.
 */

import { appendFileSync, unlinkSync } from 'fs';
import { unlink } from 'fs/promises';
import { updateTask } from './store.js';
import {
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
import { createRequire } from 'module';

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 CRITICAL: Global error handlers - MUST be installed BEFORE any async ops
// Without these, uncaught errors cause SILENT process death (no logs, no status)
// ═══════════════════════════════════════════════════════════════════════════

const [, , taskIdArg, cwdArg, logFileArg, argsJsonArg, configJsonArg] = process.argv;
let commandSpecCleanup = [];
let cleanupStarted = false;

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

function crashWithError(error, source) {
  const timestamp = Date.now();
  const errorMsg = error instanceof Error ? error.stack || error.message : String(error);

  emergencyLog(`\n[${timestamp}][CRASH] ${source}: ${errorMsg}\n`);
  emergencyLog(`[${timestamp}][CRASH] Process terminating due to unhandled error\n`);
  cleanupCommandSpecSync();

  if (taskIdArg) {
    try {
      updateTask(taskIdArg, {
        status: 'failed',
        error: `${source}: ${errorMsg}`,
        socketPath: null,
      });
    } catch (updateError) {
      emergencyLog(`[${timestamp}][CRASH] Failed to update task status: ${updateError.message}\n`);
    }
  }

  process.exit(1);
}

process.on('uncaughtException', (error) => {
  crashWithError(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  crashWithError(reason, 'unhandledRejection');
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
commandSpecCleanup = commandSpec.cleanup || [];
let server = null;

const socketPath = getTaskSocketPath(taskId);

function log(msg) {
  appendFileSync(logFile, msg);
}

const providerName = normalizeProviderName(config.provider || 'claude');
const enableRecovery = supportsProviderStructuredOutputRecovery(providerName);

const env = { ...process.env, ...(commandSpec.env || {}) };
const command = commandSpec.binary;
const finalArgs = [...(commandSpec.args || args)];

const silentJsonMode =
  config.outputFormat === 'json' &&
  config.jsonSchema &&
  config.silentJsonOutput &&
  supportsProviderStructuredOutputRecovery(providerName);

let finalResultJson = null;
let outputBuffer = '';
let streamingModeError = null;
let fatalError = null;

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

  if (server) {
    server.stop('SIGTERM').catch((error) => {
      log(`[${timestamp}][FATAL] Attach server stop failed: ${error.message}\n`);
    });
  }
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

function flushOutputBuffer(timestamp) {
  if (!outputBuffer.trim()) {
    return;
  }

  if (!enableRecovery) {
    if (!silentJsonMode) {
      log(`[${timestamp}]${outputBuffer}\n`);
    }
    return;
  }

  maybeHandleFatalError(outputBuffer, timestamp);
  if (captureStreamingError(outputBuffer, timestamp)) {
    return;
  }

  if (silentJsonMode) {
    maybeCaptureStructuredOutput(outputBuffer);
    return;
  }

  log(`[${timestamp}]${outputBuffer}\n`);
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

async function cleanupCommandSpec() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const file of commandSpecCleanup) {
    try {
      await unlink(file);
    } catch (error) {
      log(`[${Date.now()}][CLEANUP] Failed to delete ${file}: ${error.message}\n`);
    }
  }
}

function cleanupCommandSpecSync() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const file of commandSpecCleanup) {
    try {
      unlinkSync(file);
    } catch (error) {
      emergencyLog(`[${Date.now()}][CLEANUP] Failed to delete ${file}: ${error.message}\n`);
    }
  }
}

function writeCompletionFooter(code, signal) {
  if (config.outputFormat === 'json') {
    return;
  }

  log(`\n${'='.repeat(50)}\n`);
  log(`Finished: ${new Date().toISOString()}\n`);
  log(`Exit code: ${code}, Signal: ${signal}\n`);
}

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
  const chunk = data.toString();
  const timestamp = Date.now();

  const { lines, remaining } = splitBufferLines(outputBuffer, chunk);
  outputBuffer = remaining;

  if (silentJsonMode) {
    handleSilentJsonLines(lines, timestamp);
  } else {
    handleStreamingLines(lines, timestamp);
  }
});

server.on('exit', async ({ exitCode, signal }) => {
  const timestamp = Date.now();
  const code = exitCode;

  flushOutputBuffer(timestamp);

  const recovered = attemptRecovery(code, timestamp);

  if (silentJsonMode && finalResultJson) {
    log(finalResultJson + '\n');
  }

  writeCompletionFooter(code, signal);
  await cleanupCommandSpec();

  const resolvedCode = fatalError ? 1 : recovered?.payload ? 0 : code;
  const status = resolvedCode === 0 ? 'completed' : 'failed';
  try {
    await updateTask(taskId, {
      status,
      pid: null,
      processGroupId: null,
      exitCode: resolvedCode,
      error: fatalError || (resolvedCode !== 0 && signal ? `Killed by ${signal}` : null),
      socketPath: null,
    });
  } catch (updateError) {
    log(`[${Date.now()}][ERROR] Failed to update task status: ${updateError.message}\n`);
  }

  setTimeout(() => {
    process.exit(0);
  }, 500);
});

server.on('error', async (err) => {
  log(`\nError: ${err.message}\n`);
  await cleanupCommandSpec();
  try {
    await updateTask(taskId, {
      status: 'failed',
      pid: null,
      processGroupId: null,
      error: err.message,
    });
  } catch (updateError) {
    log(`[${Date.now()}][ERROR] Failed to update task status: ${updateError.message}\n`);
  }
  process.exit(1);
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
  log(`\nFailed to start: ${err.message}\n`);
  await cleanupCommandSpec();
  updateTask(taskId, { status: 'failed', error: err.message });
  process.exit(1);
}

process.on('SIGTERM', async () => {
  log(`[${Date.now()}][SYSTEM] Received SIGTERM, stopping...\n`);
  await server.stop('SIGTERM');
});

process.on('SIGINT', async () => {
  log(`[${Date.now()}][SYSTEM] Received SIGINT, stopping...\n`);
  await server.stop('SIGINT');
});
