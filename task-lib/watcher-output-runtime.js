import { spawn } from 'child_process';
import {
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
import { terminateProcess } from './process-termination.js';

export const COMMAND_CLEANUP_UNINITIALIZED = Symbol('command-cleanup-uninitialized');

export function spawnWatcherProvider(command, finalArgs, options) {
  return spawn(command, finalArgs, {
    ...options,
    windowsHide: true,
  });
}

export async function terminateWatcherProvider(providerProcess, options = {}) {
  const pid = providerProcess?.pid;
  if (!pid) return true;
  const platform = options.platform || process.platform;
  const terminate = options.terminateProcessFn || terminateProcess;
  const terminationStrategy = platform === 'win32' ? 'process-tree' : 'process-group';
  const result = await terminate(pid, {
    processGroupId: platform === 'win32' ? null : pid,
    terminationStrategy,
  });
  if (terminationStrategy === 'process-tree' && result.alreadyDead && !options.exitObserved) {
    return false;
  }
  return result.terminated;
}

function splitBufferLines(buffer, chunk) {
  const nextBuffer = buffer + chunk;
  const lines = nextBuffer.split('\n');
  return { lines: lines.slice(0, -1), remaining: lines.at(-1) || '' };
}

export function resolveWatcherCommand(config, commandSpec, fallbackArgs, normalizeProviderName) {
  return {
    providerName: normalizeProviderName(config.provider || 'claude'),
    env: { ...process.env, ...(commandSpec.env || {}) },
    command: commandSpec.binary,
    finalArgs: [...(commandSpec.args || fallbackArgs)],
  };
}

export async function completeWatcherTask({
  taskId,
  completion,
  commandCleanup,
  terminateProvider,
  updateTask,
  emergencyLog,
  terminalUpdates = {},
}) {
  let providerTerminal = false;
  try {
    providerTerminal = await terminateProvider();
  } catch (error) {
    emergencyLog(`[${Date.now()}][CLEANUP] Provider termination check failed: ${error.message}\n`);
  }
  if (!providerTerminal) {
    emergencyLog(
      `[${Date.now()}][CLEANUP] Provider termination boundary is still live; preserving command cleanup paths.\n`
    );
    try {
      await updateTask(taskId, {
        status: 'running',
        error: completion.error
          ? `${completion.error}; provider termination could not be confirmed`
          : 'Provider termination could not be confirmed; retry and cleanup remain blocked',
      });
    } catch (error) {
      emergencyLog(`[${Date.now()}][ERROR] Failed to preserve task ownership: ${error.message}\n`);
    }
    return false;
  }

  let cleanupSucceeded = false;
  if (commandCleanup === COMMAND_CLEANUP_UNINITIALIZED) {
    emergencyLog(
      `[${Date.now()}][CLEANUP] Command cleanup ownership was not initialized; preserving the persisted receipt.\n`
    );
  } else if (commandCleanup?.run) {
    try {
      cleanupSucceeded = await commandCleanup.run();
    } catch (error) {
      emergencyLog(`[${Date.now()}][CLEANUP] Command cleanup failed: ${error.message}\n`);
    }
  }
  try {
    await updateTask(taskId, {
      status: completion.status,
      pid: null,
      processGroupId: null,
      exitCode: completion.resolvedCode,
      error: completion.error,
      cancelRequested: false,
      ...terminalUpdates,
      ...(completion.terminalUpdates || {}),
      ...(cleanupSucceeded ? { commandCleanup: null } : {}),
    });
  } catch (error) {
    emergencyLog(`[${Date.now()}][ERROR] Failed to update task status: ${error.message}\n`);
  }
  return true;
}

export async function completePendingWatcherCancellation({
  taskId,
  getTask,
  ...completionOptions
}) {
  if (!getTask(taskId)?.cancelRequested) return false;
  await completeWatcherTask({
    taskId,
    ...completionOptions,
    completion: {
      status: 'killed',
      resolvedCode: 143,
      error: 'Cancellation requested before provider startup completed',
    },
  });
  return true;
}

export function completeWatcherFailure({ error, source, ...completionOptions }) {
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
  completionOptions.emergencyLog(`\n[${Date.now()}][CRASH] ${source}: ${errorMessage}\n`);
  return completeWatcherTask({
    ...completionOptions,
    completion: {
      status: 'failed',
      resolvedCode: 1,
      error: `${source}: ${errorMessage}`,
    },
  });
}

export function createWatcherOutputRuntime({
  config,
  providerName,
  log,
  stopProvider,
  providerSessionCapture = null,
}) {
  const enableRecovery = supportsProviderStructuredOutputRecovery(providerName);
  const silentJsonMode =
    config.outputFormat === 'json' &&
    config.jsonSchema &&
    config.silentJsonOutput &&
    enableRecovery;
  let finalResultJson = null;
  let streamingModeError = null;
  let fatalError = null;
  const captureProviderSession = providerSessionCapture?.captureLine || (() => {});

  function maybeHandleFatalError(line, timestamp) {
    if (fatalError) return false;
    const detected = detectProviderFatalError(providerName, line);
    if (!detected) return false;
    fatalError = detected;
    if (silentJsonMode) log(`[${timestamp}]${line}\n`);
    log(`[${timestamp}][FATAL] ${detected}\n`);
    stopProvider(timestamp);
    return true;
  }

  function captureStreamingError(line, timestamp) {
    const detectedError = detectProviderStreamingModeError(providerName, line);
    if (!detectedError) return false;
    streamingModeError = { ...detectedError, timestamp };
    return true;
  }

  function maybeCaptureStructuredOutput(line) {
    try {
      const json = JSON.parse(line);
      if (json.structured_output) finalResultJson = line;
    } catch {
      // Not JSON, skip.
    }
  }

  function handleOutputLine(line, timestamp) {
    captureProviderSession(line);
    if (silentJsonMode && !line.trim()) return;
    maybeHandleFatalError(line, timestamp);
    if (captureStreamingError(line, timestamp)) return;
    if (silentJsonMode) {
      maybeCaptureStructuredOutput(line);
    } else {
      log(`[${timestamp}]${line}\n`);
    }
  }

  function consumeOutput(buffer, chunk) {
    const timestamp = Date.now();
    const { lines, remaining } = splitBufferLines(buffer, chunk.toString());
    for (const line of lines) handleOutputLine(line, timestamp);
    return remaining;
  }

  function consumeStderr(buffer, chunk) {
    const timestamp = Date.now();
    const { lines, remaining } = splitBufferLines(buffer, chunk.toString());
    for (const line of lines) log(`[${timestamp}]${line}\n`);
    return remaining;
  }

  function flushOutput(buffer, timestamp) {
    if (!buffer.trim()) return;
    captureProviderSession(buffer);
    if (!enableRecovery) {
      if (!silentJsonMode) log(`[${timestamp}]${buffer}\n`);
      return;
    }
    maybeHandleFatalError(buffer, timestamp);
    if (captureStreamingError(buffer, timestamp)) return;
    if (silentJsonMode) {
      maybeCaptureStructuredOutput(buffer);
    } else {
      log(`[${timestamp}]${buffer}\n`);
    }
  }

  function flushStderr(buffer, timestamp) {
    if (!buffer.trim()) return;
    maybeHandleFatalError(buffer, timestamp);
    log(`[${timestamp}]${buffer}\n`);
  }

  function attemptRecovery(code, timestamp) {
    if (!(code !== 0 && streamingModeError?.sessionId)) return null;
    const recovered = recoverProviderStructuredOutput(providerName, streamingModeError.sessionId);
    if (recovered?.payload) {
      const recoveredLine = JSON.stringify(recovered.payload);
      if (silentJsonMode) {
        finalResultJson = recoveredLine;
      } else {
        log(`[${timestamp}]${recoveredLine}\n`);
      }
    } else if (streamingModeError.line) {
      const prefix = silentJsonMode ? '' : `[${streamingModeError.timestamp}]`;
      log(`${prefix}${streamingModeError.line}\n`);
    }
    return recovered;
  }

  function complete({ code, signal, outputBuffer, stderrBuffer = null }) {
    const timestamp = Date.now();
    flushOutput(outputBuffer, timestamp);
    if (stderrBuffer !== null) flushStderr(stderrBuffer, timestamp);
    const recovered = attemptRecovery(code, timestamp);
    const sessionIdentityError = providerSessionCapture?.getCompletionError() || null;
    if (silentJsonMode && finalResultJson) log(`${finalResultJson}\n`);
    if (config.outputFormat !== 'json') {
      log(`\n${'='.repeat(50)}\n`);
      log(`Finished: ${new Date().toISOString()}\n`);
      log(`Exit code: ${code}, Signal: ${signal}\n`);
    }
    let resolvedCode = code;
    if (recovered?.payload) {
      resolvedCode = 0;
    }
    if (fatalError || sessionIdentityError) {
      resolvedCode = 1;
    }
    return {
      resolvedCode,
      status: resolvedCode === 0 ? 'completed' : 'failed',
      error:
        fatalError ||
        sessionIdentityError ||
        (resolvedCode !== 0 && signal ? `Killed by ${signal}` : null),
      terminalUpdates: providerSessionCapture?.getCompletionUpdate(resolvedCode) || {},
    };
  }

  return { complete, consumeOutput, consumeStderr };
}
