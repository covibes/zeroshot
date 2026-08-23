import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import {
  classifyProviderError,
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
} from './provider-helper-runtime.js';
import { terminateProcess } from './process-termination.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  TASK_LOG_STDOUT_PREFIX,
  formatTaskLogMarker,
  formatTaskLogStdout,
} = require('../src/task-log-line.js');
const { redactObject } = require('../lib/agent-cli-provider/redaction.js');

export const COMMAND_CLEANUP_UNINITIALIZED = Symbol('command-cleanup-uninitialized');

const MAX_CODEX_CONTROL_RECORD_BYTES = 64 * 1024;
const MAX_WATCHER_CONTROL_RECORD_BYTES = 1024 * 1024;
const MAX_PROVIDER_DIAGNOSTIC_BYTES = 2048;
const MAX_PERSISTED_PROVIDER_ERROR_BYTES = 4096;
const PROVIDER_DIAGNOSTIC_TRUNCATION_SUFFIX = '… [truncated; complete output in task log]';

const ACTIONABLE_PROVIDER_FAILURE_PATTERNS = [
  /(?:^|[^a-z])(?:error|failed|failure|fatal|exception)(?:[^a-z]|$)/i,
  /\b(?:unauthorized|forbidden|denied|refused|unavailable|timeout|timed out)\b/i,
  /\b(?:too many requests|try again|no capacity available|quota exceeded)\b/i,
  /\b(?:command|model) not found\b/i,
  /\b(?:econnreset|econnrefused|etimedout|eai_again)\b/i,
  /\b(?:http|status(?: code)?)\s*[:=]?\s*[45]\d\d\b/i,
  /\b(?:missing|no)\s+(?:key|api\s+key)\b/i,
  /\b(?:login|authentication)\s+(?:required|failed|failure|denied)\b/i,
  /invalid[_ -]?(?:api[_ -]?key|argument|request)/i,
  /(?:unsupported[_ -]?client|ineligible[_ -]?tier|resource[_ -]?exhausted)/i,
  /(?:rate[_ -]?limit|insufficient[_ -]?quota|context[_ -]?length[_ -]?exceeded)/i,
];

function truncateUtf8(value, maxBytes, suffix = PROVIDER_DIAGNOSTIC_TRUNCATION_SUFFIX) {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  const suffixBytes = Buffer.byteLength(suffix);
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    prefix += character;
    bytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

const SENSITIVE_ASSIGNMENT_KEYS = new Set([
  'access_token',
  'api_key',
  'auth',
  'authorization',
  'aws_secret_access_key',
  'password',
  'secret',
  'signature',
  'token',
]);

function isSensitiveAssignmentKey(key) {
  const normalized = key.toLowerCase().replace(/[ -]+/g, '_');
  if (SENSITIVE_ASSIGNMENT_KEYS.has(normalized)) return true;
  return [...SENSITIVE_ASSIGNMENT_KEYS].some((suffix) => normalized.endsWith(`_${suffix}`));
}

function unquotedAssignmentValueEnd(value, offset) {
  let index = offset;
  while (index < value.length && !/[\s,;&#]/.test(value[index])) index += 1;
  return index;
}

function assignmentValueEnd(value, offset) {
  const quote = value[offset];
  if (quote !== '"' && quote !== "'") return unquotedAssignmentValueEnd(value, offset);
  for (let index = offset + 1; index < value.length; index += 1) {
    if (value[index] === '\\') index += 1;
    else if (value[index] === quote) return index + 1;
  }
  return value.length;
}

function sensitiveAssignmentValueEnd(value, offset) {
  const authenticationScheme = /^(?:basic|bearer)\s+/i.exec(value.slice(offset));
  if (!authenticationScheme) return assignmentValueEnd(value, offset);
  return assignmentValueEnd(value, offset + authenticationScheme[0].length);
}

function redactStandaloneBearerCredentials(value) {
  const bearerPattern = /\bBearer\s+/gi;
  let redacted = '';
  let retainedOffset = 0;
  while (bearerPattern.exec(value) !== null) {
    const valueOffset = bearerPattern.lastIndex;
    const valueEnd = assignmentValueEnd(value, valueOffset);
    if (valueEnd === valueOffset) continue;
    redacted += `${value.slice(retainedOffset, valueOffset)}[REDACTED]`;
    retainedOffset = valueEnd;
    bearerPattern.lastIndex = valueEnd;
  }
  return `${redacted}${value.slice(retainedOffset)}`;
}

function redactSensitiveAssignments(value) {
  const assignmentPattern = /\b(api key|access token|[a-z][a-z0-9_-]*)\s*[:=]\s*/gi;
  let redacted = '';
  let retainedOffset = 0;
  let match;
  while ((match = assignmentPattern.exec(value)) !== null) {
    if (!isSensitiveAssignmentKey(match[1])) continue;
    const valueOffset = assignmentPattern.lastIndex;
    const valueEnd = sensitiveAssignmentValueEnd(value, valueOffset);
    if (valueEnd === valueOffset) continue;
    redacted += `${value.slice(retainedOffset, valueOffset)}[REDACTED]`;
    retainedOffset = valueEnd;
    assignmentPattern.lastIndex = valueEnd;
  }
  return `${redacted}${value.slice(retainedOffset)}`;
}

function redactProviderDiagnostic(value) {
  const providerRedacted = redactObject({ diagnostic: value }).value;
  const knownSecretRedacted =
    typeof providerRedacted?.diagnostic === 'string' ? providerRedacted.diagnostic : value;
  return redactStandaloneBearerCredentials(redactSensitiveAssignments(knownSecretRedacted))
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|key|signature|x-amz-signature)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[REDACTED]@');
}

function skipAnsiCsi(value, offset) {
  let index = offset;
  while (
    index < value.length &&
    value.charCodeAt(index) >= 0x30 &&
    value.charCodeAt(index) <= 0x3f
  ) {
    index += 1;
  }
  while (
    index < value.length &&
    value.charCodeAt(index) >= 0x20 &&
    value.charCodeAt(index) <= 0x2f
  ) {
    index += 1;
  }
  if (index < value.length && value.charCodeAt(index) >= 0x40 && value.charCodeAt(index) <= 0x7e) {
    index += 1;
  }
  return index;
}

function skipAnsiOsc(value, offset) {
  let index = offset;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function diagnosticCharacter(value, index) {
  const code = value.charCodeAt(index);
  if (code === 9) return ' ';
  if (code >= 32 && !(code >= 127 && code <= 159)) return value[index];
  return '';
}

function stripAnsiAndControlCharacters(value) {
  let stripped = '';
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5b) {
      index = skipAnsiCsi(value, index + 2);
      continue;
    }
    if (code === 0x9b) {
      index = skipAnsiCsi(value, index + 1);
      continue;
    }
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5d) {
      index = skipAnsiOsc(value, index + 2);
      continue;
    }
    if (code === 0x9d) {
      index = skipAnsiOsc(value, index + 1);
      continue;
    }
    stripped += diagnosticCharacter(value, index);
    index += 1;
  }
  return stripped;
}

export function sanitizeProviderDiagnostic(value) {
  const redactedRecords = String(value)
    .split(/\r\n|\n|\r/)
    .map((record) => redactProviderDiagnostic(stripAnsiAndControlCharacters(record)))
    .join(' ');
  return truncateUtf8(redactedRecords.replace(/\s+/g, ' ').trim(), MAX_PROVIDER_DIAGNOSTIC_BYTES);
}

function providerFailureSignalScore(diagnostic) {
  return ACTIONABLE_PROVIDER_FAILURE_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(diagnostic) ? 1 : 0),
    0
  );
}

function fallbackProviderErrorClassification() {
  return { retryable: true, kind: 'unknown-retryable' };
}

function classifyWatcherProviderError(providerName, diagnostic) {
  try {
    return classifyProviderError(providerName, diagnostic);
  } catch {
    return fallbackProviderErrorClassification();
  }
}

function createProviderDiagnosticCapture() {
  let latest = null;
  let best = null;
  let sequence = 0;

  function capture(line) {
    const diagnostic = sanitizeProviderDiagnostic(line);
    if (!diagnostic) return;
    sequence += 1;
    const candidate = {
      diagnostic,
      failureScore: providerFailureSignalScore(diagnostic),
      sequence,
    };
    latest = candidate;
    if (
      best === null ||
      candidate.failureScore > best.failureScore ||
      (candidate.failureScore === best.failureScore && candidate.sequence > best.sequence)
    ) {
      best = candidate;
    }
  }

  function select() {
    if (best?.failureScore > 0) return best;
    return latest;
  }

  return { capture, select };
}

function formatProviderExitError(providerName, resolvedCode, capturedDiagnostic) {
  const diagnostic = capturedDiagnostic?.diagnostic || 'No provider diagnostic was captured';
  const providerClassification = classifyWatcherProviderError(providerName, diagnostic);
  const classification =
    capturedDiagnostic?.failureScore > 0
      ? providerClassification
      : fallbackProviderErrorClassification();
  const disposition = classification.retryable ? 'retryable' : 'permanent';
  const exitCode = resolvedCode === null || resolvedCode === undefined ? 'unknown' : resolvedCode;
  return truncateUtf8(
    `Provider ${providerName} exited with code ${exitCode} ` +
      `(${disposition}; ${classification.kind}): ${diagnostic}`,
    MAX_PERSISTED_PROVIDER_ERROR_BYTES
  );
}

function resolveWatcherCompletionError({
  fatalError,
  sessionIdentityError,
  resolvedCode,
  signal,
  providerName,
  providerDiagnostics,
}) {
  if (fatalError) return fatalError;
  if (sessionIdentityError) return sessionIdentityError;
  if (resolvedCode === 0) return null;
  if (signal) return `Killed by ${signal}`;
  return formatProviderExitError(providerName, resolvedCode, providerDiagnostics.select());
}

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

function createCodexOutputPassthrough({ log, captureProviderSession, captureDiagnostic }) {
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
    if (inspectable) {
      const line = inspectionParts.join('');
      captureProviderSession(line);
      captureDiagnostic(line);
    }
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
        logged.push(`[${timestamp}]${TASK_LOG_STDOUT_PREFIX}`);
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
        log(`[${lineTimestamp}]${linePrefix}${inspectionParts.join('')}${part}`);
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
  log(formatTaskLogMarker(Date.now()));

  function logEvent(event) {
    log(formatTaskLogStdout(Date.now(), JSON.stringify(event)));
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
  const providerDiagnostics = createProviderDiagnosticCapture();
  log(formatTaskLogMarker(Date.now()));
  const captureProviderSession = providerSessionCapture?.captureLine || (() => {});
  const codexOutputPassthrough =
    providerName === 'codex'
      ? createCodexOutputPassthrough({
          log,
          captureProviderSession,
          captureDiagnostic: providerDiagnostics.capture,
        })
      : null;
  const outputPassthrough = codexOutputPassthrough
    ? null
    : createBoundedLinePassthrough({
        log,
        deferRawUntilOverflow: silentJsonMode,
        linePrefix: TASK_LOG_STDOUT_PREFIX,
        handleLine: (line, timestamp, { oversized }) =>
          handleOutputLine(line, timestamp, {
            alreadyLogged: !silentJsonMode,
            oversized,
          }),
      });
  const stderrPassthrough = createBoundedLinePassthrough({
    log,
    // Stderr must never be mistaken for provider protocol output. Fatal detection still receives
    // the raw line through handleLine; only the persisted task-log representation is tagged.
    linePrefix: '[ZEROSHOT][PROVIDER_STDERR] ',
    handleLine: (line, timestamp) => {
      providerDiagnostics.capture(line);
      maybeHandleFatalError(line, timestamp, true);
    },
  });

  function maybeHandleFatalError(line, timestamp, rawPersisted = false) {
    if (fatalError) return false;
    const detected = detectProviderFatalError(providerName, line);
    if (!detected) return false;
    fatalError = detected;
    if (silentJsonMode && !rawPersisted) {
      log(formatTaskLogStdout(timestamp, line));
    }
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
    providerDiagnostics.capture(line);
    if (silentJsonMode && !line.trim()) return;
    // Pi reserves stdout for JSON lifecycle events. Error text inside an assistant message may be
    // followed by an automatic retry, so only Pi stderr can prove a pre-agent startup failure.
    if (providerName !== 'pi') maybeHandleFatalError(line, timestamp, alreadyLogged);
    if (captureStreamingError(line, timestamp)) return;
    if (silentJsonMode) {
      maybeCaptureStructuredOutput(line);
    } else if (!alreadyLogged) {
      log(formatTaskLogStdout(timestamp, line));
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
        log(formatTaskLogStdout(timestamp, recoveredLine));
      }
    } else if (streamingModeError.line) {
      log(formatTaskLogStdout(streamingModeError.timestamp, streamingModeError.line));
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
    if (silentJsonMode && finalResultJson) {
      log(formatTaskLogStdout(timestamp, finalResultJson));
    }
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
      error: resolveWatcherCompletionError({
        fatalError,
        sessionIdentityError,
        resolvedCode,
        signal,
        providerName,
        providerDiagnostics,
      }),
      terminalUpdates: providerSessionCapture?.getCompletionUpdate(resolvedCode) || {},
    };
  }

  return { complete, consumeOutput, consumeStderr };
}
