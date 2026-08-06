'use strict';

const { validateLegacyShipResult, validateWorkerOutcome } = require('./contracts');
const { cloneJson, deepFreeze } = require('./object-utils');
const { collectReceipts } = require('./runtime-support');

async function resultFromEvent(event, options) {
  let result;
  let declaredArtifacts;
  if (Object.prototype.hasOwnProperty.call(event, 'result')) {
    validateLegacyShipResult(event.result);
    result = event.result;
    declaredArtifacts = event.result.artifacts;
  } else {
    result = { summary: event.summary, status: 'succeeded', artifacts: [] };
    validateLegacyShipResult(result);
    declaredArtifacts = [];
  }
  const artifacts = await collectReceipts(options.artifactReceiptSink, declaredArtifacts, {
    clusterId: options.machine.clusterId,
    profile: options.getProfile(),
    signal: options.signal,
    reportCleanupFailure: options.cleanupFailureReporter,
  });
  if (artifacts === options.cancelled) return options.cancelled;
  const normalized = { ...result, artifacts };
  validateLegacyShipResult(normalized);
  return normalized;
}

function createTerminalNormalizer(options) {
  let completionPending = false;

  function terminalFailure(authority, state, code, reason) {
    if (options.claimTerminalAuthority(authority)) {
      options.machine.terminal(options.failureReceipt(state, code, reason));
    }
  }

  async function normalizeCompletion(event) {
    try {
      const result = await Promise.race([resultFromEvent(event, options), options.terminalClaimed]);
      if (result === options.cancelled) return;
      if (options.claimTerminalAuthority('engine:complete')) {
        options.machine.terminal({
          state: 'completed',
          clusterId: options.machine.clusterId,
          finishedAt: options.clock(),
          result: deepFreeze(cloneJson(result)),
        });
      }
    } catch {
      terminalFailure('engine:complete:malformed', 'malformed', 'malformed', 'malformed_result');
    } finally {
      completionPending = false;
    }
  }

  function normalizeFailure(event) {
    try {
      validateWorkerOutcome({ status: 'error', code: event.code, reason: event.reason });
      terminalFailure('engine:failed', 'failed', event.code, event.reason);
    } catch {
      terminalFailure('engine:failed:malformed', 'malformed', 'malformed', 'malformed_result');
    }
  }

  function beginCompletion(event) {
    if (completionPending) return;
    completionPending = true;
    normalizeCompletion(event).catch(() => undefined);
  }

  const terminalHandlers = {
    failed: normalizeFailure,
    malformed() {
      terminalFailure('engine:malformed', 'malformed', 'malformed', 'malformed_result');
    },
  };

  return function onEngineEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (event.type === 'running') {
      if (options.machine.state === 'starting') options.machine.transition('running');
      return;
    }
    if (options.isTerminal()) return;
    if (event.type === 'complete') return beginCompletion(event);
    if (completionPending) return;
    terminalHandlers[event.type]?.(event);
  };
}

module.exports = { createTerminalNormalizer };
