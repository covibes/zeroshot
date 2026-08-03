import { createRequire } from 'module';
import { spawn } from 'child_process';
import {
  buildAcpPrompt,
  createOmpSdkProtocolCollector,
  decodeOmpSdkSidecarRequest,
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  runAcpStdioPrompt,
  spawnOmpSdkProcess,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
import { terminateProcess } from './process-termination.js';

const require = createRequire(import.meta.url);

const OMP_SDK_PARSER = 'omp-sdk-ndjson';

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

export function isOmpSdkWatcherConfig(config) {
  const prepared = config?.preparedInvocation;
  return (
    prepared?.invoke?.parser === OMP_SDK_PARSER ||
    prepared?.executionIdentity?.backend === 'omp-sdk'
  );
}

export function isAcpStdioWatcherConfig(config) {
  return config?.preparedInvocation?.invoke?.lane === 'acp-stdio';
}

export function runPreparedAcpStdioWatcher(config, commandSpec, finalArgs, providerName) {
  const prepared = config.preparedInvocation;
  if (
    prepared.invoke.parser !== 'acp' ||
    prepared.invoke.ptyEligible !== false ||
    prepared.invoke.strictTerminal !== false ||
    typeof prepared.context !== 'string'
  ) {
    throw new Error('ACP stdio prepared invocation is incomplete or inconsistent');
  }
  return runAcpStdioPrompt(
    providerName,
    { ...commandSpec, args: [...finalArgs] },
    buildAcpPrompt(prepared.context, { jsonSchema: config.jsonSchema })
  );
}

export function spawnPreparedOmpSdkWatcherProcess(
  preparedInvocation,
  commandSpec,
  finalArgs,
  options = {}
) {
  return spawnOmpSdkProcess(
    {
      ...preparedInvocation,
      commandSpec: {
        ...commandSpec,
        args: [...finalArgs],
        env: {},
      },
    },
    options
  );
}
export function spawnPreparedOmpSdkContainerWatcherProcess(
  preparedInvocation,
  commandSpec,
  finalArgs,
  containerExecution,
  options = {}
) {
  if (
    preparedInvocation?.containmentRequirement?.mode !== 'container' ||
    typeof containerExecution?.containerId !== 'string'
  ) {
    throw new Error('OMP SDK container watcher is missing its prepared containment identity');
  }
  const prepared = {
    ...preparedInvocation,
    commandSpec: {
      ...commandSpec,
      args: [...finalArgs],
      env: {},
    },
  };
  const { readFileSync } = require('fs');
  const IsolationManager = require('../src/isolation-manager.js');
  const requestBytes = readFileSync(prepared.privateArtifacts.requestPath);
  let request;
  try {
    request = decodeOmpSdkSidecarRequest(requestBytes);
  } finally {
    requestBytes.fill(0);
  }
  const collector = createOmpSdkProtocolCollector({ request });
  const manager = new IsolationManager();
  const managerKey = `prepared-${containerExecution.containerId}`;
  manager.containers.set(managerKey, containerExecution.containerId);
  const abortController = new AbortController();
  const proc = manager.spawnPreparedInContainer(containerExecution.containerId, prepared, {
    signal: abortController.signal,
  });
  const stderrChunks = [];
  let stderrBytes = 0;
  let protocolError = null;
  proc.stdout.on('data', (chunk) => {
    if (protocolError) return;
    try {
      for (const frame of collector.write(chunk)) {
        if (frame.type === 'progress') options.onProgress?.(frame);
      }
    } catch (error) {
      protocolError = error;
      abortController.abort();
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (stderrBytes >= 64 * 1024) return;
    const bounded = Buffer.from(chunk).subarray(0, 64 * 1024 - stderrBytes);
    stderrChunks.push(bounded);
    stderrBytes += bounded.byteLength;
  });

  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      try {
        await proc.credentialHandoff;
        const cleanupAttestation = await proc.cleanupAttestation;
        if (spawnError) throw spawnError;
        if (protocolError) throw protocolError;
        if (!Number.isInteger(code)) {
          throw new Error('OMP SDK container process exit could not be observed');
        }
        resolve({
          terminal: collector.finish(code),
          progress: [...collector.progress],
          diagnosticStderr: Buffer.concat(stderrChunks).toString('utf8'),
          cleanupAttestation,
        });
      } catch (error) {
        reject(error);
      }
    };
    proc.once('error', (error) => finish(null, error));
    proc.once('close', (code) => finish(code));
  });

  return {
    pid: proc.pid,
    cancel() {
      abortController.abort();
    },
    result,
  };
}

export function resolveWatcherCommand(
  config,
  commandSpec,
  fallbackArgs,
  normalizeProviderName,
  sourceEnv = process.env
) {
  if (isOmpSdkWatcherConfig(config) || isAcpStdioWatcherConfig(config)) {
    throw new Error('Prepared non-spawn commands require their declared process runner');
  }
  return {
    providerName: normalizeProviderName(config.provider || 'claude'),
    env: { ...sourceEnv, ...(commandSpec.env || {}) },
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
  containmentRequirement = null,
  terminalBuffered = true,
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

  const requiresAttestation = containmentRequirement?.required === true;
  const completionUpdates = {
    ...terminalUpdates,
    ...(completion.terminalUpdates || {}),
  };
  const suppliedAttestation = completionUpdates.cleanupAttestation;
  const suppliedAttestationValid =
    suppliedAttestation === undefined ||
    (suppliedAttestation?.mode === containmentRequirement?.mode &&
      suppliedAttestation.terminalBuffered === true &&
      suppliedAttestation.descendantsReaped === true &&
      suppliedAttestation.clean === true);
  const clean =
    providerTerminal && cleanupSucceeded && terminalBuffered && suppliedAttestationValid;
  let finalCompletion = completion;
  if (requiresAttestation && clean) {
    completionUpdates.cleanupAttestation = {
      mode: containmentRequirement.mode,
      terminalBuffered: true,
      descendantsReaped: true,
      clean: true,
    };
  } else if (requiresAttestation) {
    finalCompletion = {
      ...completion,
      status: 'failed',
      resolvedCode: 1,
      error: 'OMP SDK cleanup-error: provider cleanup could not be attested',
    };
    completionUpdates.parsedResult = null;
    completionUpdates.cleanupAttestation = null;
  }

  try {
    await updateTask(taskId, {
      status: finalCompletion.status,
      pid: null,
      processGroupId: null,
      exitCode: finalCompletion.resolvedCode,
      error: finalCompletion.error,
      cancelRequested: false,
      ...completionUpdates,
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

function sdkEvidenceForTerminal(terminal) {
  const frame = terminal.frame;
  if (terminal.type === 'result') {
    return {
      protocolVersion: frame.protocolVersion,
      runId: frame.runId,
      terminalType: 'result',
      invocation: terminal.event.invocation,
      ...terminal.event.ompSdk,
    };
  }
  return {
    protocolVersion: frame.protocolVersion,
    runId: frame.runId,
    terminalType: 'error',
    backend: frame.backend,
    runtime: frame.runtime,
    error: frame.error,
  };
}

export function completeOmpSdkProcessResult(
  result,
  { cancellationRequested = false, log = () => {}, containmentRequirement = null } = {}
) {
  if (result.diagnosticStderr?.trim()) {
    log(`[${Date.now()}][DIAGNOSTIC] ${result.diagnosticStderr.slice(0, 4096)}\n`);
  }
  const cleanupAttestation = result.cleanupAttestation;
  const expectedCleanupMode = containmentRequirement?.mode || 'host-process-tree';
  const cleanupAttested =
    cleanupAttestation?.mode === expectedCleanupMode &&
    cleanupAttestation.terminalBuffered === true &&
    cleanupAttestation.descendantsReaped === true &&
    cleanupAttestation.clean === true;
  if (!cleanupAttested) {
    return {
      status: 'failed',
      resolvedCode: 1,
      error: 'OMP SDK cleanup-error: canonical runner omitted cleanup attestation',
      cleanupUncertain: true,
      terminalUpdates: { parsedResult: null, cleanupAttestation: null },
    };
  }
  const terminal = result.terminal;
  const sdkEvidence = sdkEvidenceForTerminal(terminal);
  const terminalUpdates = {
    parsedResult: null,
    sdkEvidence,
    cleanupAttestation,
  };
  if (cancellationRequested) {
    return {
      status: 'killed',
      resolvedCode: 143,
      error: 'Cancellation requested',
      terminalUpdates,
    };
  }
  if (terminal.type === 'error') {
    const cancelled = terminal.frame.error.code === 'cancelled';
    return {
      status: cancelled ? 'killed' : 'failed',
      resolvedCode: cancelled ? 143 : 1,
      error: `OMP SDK ${terminal.frame.error.code}`,
      terminalUpdates,
    };
  }
  return {
    status: 'completed',
    resolvedCode: 0,
    error: null,
    terminalUpdates: {
      ...terminalUpdates,
      parsedResult: terminal.event.result,
    },
  };
}

export function completeOmpSdkProcessFailure(error, cancellationRequested = false) {
  const code =
    typeof error?.code === 'string' &&
    ['cleanup-error', 'containment-error', 'credential-error', 'protocol-error'].includes(
      error.code
    )
      ? error.code
      : 'protocol-error';
  return {
    status: cancellationRequested ? 'killed' : 'failed',
    resolvedCode: cancellationRequested ? 143 : 1,
    error: cancellationRequested ? 'Cancellation requested' : `OMP SDK ${code}`,
    terminalUpdates: { parsedResult: null },
  };
}

export function createWatcherOutputRuntime(options) {
  if (isOmpSdkWatcherConfig(options.config)) {
    throw new Error('OMP SDK output is owned by the canonical SDK process runner');
  }
  return createLegacyWatcherOutputRuntime(options);
}

function createLegacyWatcherOutputRuntime({
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
