import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import {
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
import { terminateProcess } from './process-termination.js';

export const COMMAND_CLEANUP_UNINITIALIZED = Symbol('command-cleanup-uninitialized');

const MAX_CODEX_CONTROL_RECORD_BYTES = 64 * 1024;
const MAX_WATCHER_CONTROL_RECORD_BYTES = 1024 * 1024;

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

function createCodexOutputPassthrough({ log, captureProviderSession }) {
  const decoder = new StringDecoder('utf8');
  let atLineStart = true;
  let inspectable = true;
  let inspectionBytes = 0;
  let inspectionParts = [];

  function inspectPart(part) {
    if (!inspectable || !part) return;
    inspectionBytes += Buffer.byteLength(part);
    if (inspectionBytes > MAX_CODEX_CONTROL_RECORD_BYTES) {
      inspectable = false;
      inspectionParts = [];
      return;
    }
    inspectionParts.push(part);
  }

  function finishLine() {
    if (inspectable) captureProviderSession(inspectionParts.join(''));
    atLineStart = true;
    inspectable = true;
    inspectionBytes = 0;
    inspectionParts = [];
  }

  function writeText(text, timestamp) {
    if (!text) return;
    const logged = [];
    let offset = 0;
    while (offset < text.length) {
      if (atLineStart) {
        logged.push(`[${timestamp}]`);
        atLineStart = false;
      }
      const newline = text.indexOf('\n', offset);
      if (newline === -1) {
        const part = text.slice(offset);
        inspectPart(part);
        logged.push(part);
        break;
      }
      const part = text.slice(offset, newline);
      inspectPart(part);
      logged.push(part, '\n');
      finishLine();
      offset = newline + 1;
    }
    log(logged.join(''));
  }

  return {
    consume(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      writeText(text, Date.now());
    },
    flush() {
      writeText(decoder.end(), Date.now());
      if (!atLineStart) {
        finishLine();
        log('\n');
      }
    },
  };
}

function createBoundedLinePassthrough({
  log,
  handleLine,
  deferRawUntilOverflow = false,
  linePrefix = '',
}) {
  const decoder = new StringDecoder('utf8');
  let atLineStart = true;
  let lineTimestamp = null;
  let byteLength = 0;
  let inspectable = true;
  let inspectionParts = [];
  let digest = createHash('sha256');
  let rawOverflowStreaming = false;

  function inspectPart(part) {
    if (!part) return;
    byteLength += Buffer.byteLength(part);
    digest.update(part);
    if (!inspectable) {
      if (deferRawUntilOverflow && log) log(part);
      return;
    }
    if (byteLength > MAX_WATCHER_CONTROL_RECORD_BYTES) {
      if (deferRawUntilOverflow && log) {
        log(`[${lineTimestamp}]${inspectionParts.join('')}${part}`);
        rawOverflowStreaming = true;
      }
      inspectable = false;
      inspectionParts = [];
      return;
    }
    inspectionParts.push(part);
  }

  function finishLine() {
    const oversized = !inspectable;
    const line = inspectable
      ? inspectionParts.join('')
      : `[ZEROSHOT] Provider output record retained in task log but omitted from watcher inspection ` +
        `(byte_length=${byteLength}, sha256=${digest.digest('hex')})`;
    handleLine(line, lineTimestamp || Date.now(), { oversized });
    atLineStart = true;
    lineTimestamp = null;
    byteLength = 0;
    inspectable = true;
    inspectionParts = [];
    digest = createHash('sha256');
    rawOverflowStreaming = false;
  }

  function appendRaw(logged, ...parts) {
    if (log && !deferRawUntilOverflow) logged.push(...parts);
  }

  function writeText(text) {
    if (!text) return;
    const logged = [];
    let offset = 0;
    while (offset < text.length) {
      if (atLineStart) {
        lineTimestamp = Date.now();
        appendRaw(logged, `[${lineTimestamp}]${linePrefix}`);
        atLineStart = false;
      }
      const newline = text.indexOf('\n', offset);
      if (newline === -1) {
        const part = text.slice(offset);
        inspectPart(part);
        appendRaw(logged, part);
        break;
      }
      const part = text.slice(offset, newline);
      inspectPart(part);
      appendRaw(logged, part, '\n');
      if (deferRawUntilOverflow && rawOverflowStreaming && log) log('\n');
      finishLine();
      offset = newline + 1;
    }
    if (log && logged.length > 0) log(logged.join(''));
  }

  return {
    consume(chunk) {
      writeText(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    flush() {
      writeText(decoder.end());
      if (!atLineStart) {
        if (deferRawUntilOverflow && rawOverflowStreaming && log) log('\n');
        finishLine();
        if (log && !deferRawUntilOverflow) log('\n');
      }
    },
  };
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

/**
 * Output runtime for the rpc-stdio lane (see task-lib/rpc-watcher.js). Unlike
 * createWatcherOutputRuntime, there is no raw stdout/stderr byte stream to parse: the
 * OMP RPC driver (omp-rpc-driver.ts) already normalizes every frame into an OutputEvent before
 * calling onEvent, so this runtime only ever logs already-normalized events — never raw RPC
 * frames, prompt text, or control payloads.
 */
export function createRpcWatcherOutputRuntime({ log }) {
  function logEvent(event) {
    log(`[${Date.now()}]${JSON.stringify(event)}\n`);
  }

  function complete(result) {
    const lastResult = [...result.events].reverse().find((event) => event.type === 'result');
    const turnFailed = lastResult !== undefined && lastResult.success === false;
    const success = result.stopReason === 'completed' && !turnFailed;
    const resolvedCode = success ? 0 : 1;
    log(`\n${'='.repeat(50)}\n`);
    log(`Finished: ${new Date().toISOString()}\n`);
    log(
      `Stop reason: ${result.stopReason}, Exit code: ${result.exitCode}, Signal: ${result.signal}\n`
    );
    return {
      resolvedCode,
      status: success ? 'completed' : 'failed',
      error: success ? null : (lastResult && lastResult.error) || result.stopReason,
    };
  }

  return { logEvent, complete };
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
  const codexOutputPassthrough =
    providerName === 'codex' ? createCodexOutputPassthrough({ log, captureProviderSession }) : null;
  const outputPassthrough = codexOutputPassthrough
    ? null
    : createBoundedLinePassthrough({
        log,
        deferRawUntilOverflow: silentJsonMode,
        handleLine: (line, timestamp, { oversized }) =>
          handleOutputLine(line, timestamp, {
            alreadyLogged: !silentJsonMode,
            oversized,
          }),
      });
  const stderrPassthrough = createBoundedLinePassthrough({
    log,
    // Pi reserves stdout for its JSON protocol and deliberately routes ordinary writes to
    // stderr. Keep those diagnostics in the task log with explicit provenance so followers can
    // exclude them from strict JSON validation.
    linePrefix: providerName === 'pi' ? '[ZEROSHOT][PROVIDER_STDERR] ' : '',
    handleLine: (line, timestamp) => maybeHandleFatalError(line, timestamp),
  });

  function maybeHandleFatalError(line, timestamp) {
    if (fatalError) return false;
    const detected = detectProviderFatalError(providerName, line);
    if (!detected) return false;
    fatalError = detected;
    if (silentJsonMode) log(`[${timestamp}]${line}\n`);
    log(`[${timestamp}][ZEROSHOT][FATAL] ${detected}\n`);
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

  function handleOutputLine(line, timestamp, { alreadyLogged = false, oversized = false } = {}) {
    if (silentJsonMode && oversized) {
      fatalError =
        `Provider structured output exceeded the ${MAX_WATCHER_CONTROL_RECORD_BYTES}-byte ` +
        'watcher inspection limit; complete output remains in the task log';
      log(`[${timestamp}][ZEROSHOT][FATAL] ${fatalError}\n`);
      stopProvider(timestamp);
      return;
    }
    captureProviderSession(line);
    if (silentJsonMode && !line.trim()) return;
    // Pi reserves stdout for JSON lifecycle events. Error text inside an assistant message may be
    // followed by an automatic retry, so only Pi stderr can prove a pre-agent startup failure.
    if (providerName !== 'pi') maybeHandleFatalError(line, timestamp);
    if (captureStreamingError(line, timestamp)) return;
    if (silentJsonMode) {
      maybeCaptureStructuredOutput(line);
    } else if (!alreadyLogged) {
      log(`[${timestamp}]${line}\n`);
    }
  }

  function consumeOutput(_buffer, chunk) {
    if (codexOutputPassthrough) {
      codexOutputPassthrough.consume(chunk);
    } else {
      outputPassthrough.consume(chunk);
    }
    return '';
  }

  function consumeStderr(_buffer, chunk) {
    stderrPassthrough.consume(chunk);
    return '';
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

  function complete({ code, signal, stderrBuffer = null }) {
    const timestamp = Date.now();
    if (codexOutputPassthrough) {
      codexOutputPassthrough.flush();
    } else {
      outputPassthrough.flush();
    }
    if (stderrBuffer !== null) stderrPassthrough.flush();
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
