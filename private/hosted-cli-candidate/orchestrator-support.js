'use strict';

const { validateLegacyShipRequest } = require('../../lib/cluster-worker/contracts');

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HOSTED_INPUT_KEYS = new Set(['artifacts', 'issue', 'prompt', 'source']);
const DETERMINISTIC_ALLOCATION_CODES = new Set([
  'AUTH_FAILED',
  'SERVER_REJECTED',
  'CAPACITY',
  'NOT_FOUND',
  'RATE_LIMITED',
]);

function isDeterministicAllocationRefusal(error) {
  return DETERMINISTIC_ALLOCATION_CODES.has(error?.code);
}

function buildLegacyShipRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('hosted input must be a LegacyShipRequest object');
  }
  const unsupported = Object.keys(input).find((key) => !HOSTED_INPUT_KEYS.has(key));
  if (unsupported !== undefined) {
    throw new Error(`hosted input contains unsupported field ${unsupported}`);
  }
  if (input.source === 'artifact') {
    throw new Error('hosted artifact input is unavailable without trusted artifact staging');
  }
  validateLegacyShipRequest({
    ...input,
    isolationProfile: 'isolation.prepared-worktree@1',
    providerProfile: 'provider.hosted-direct@1',
    repository: 'runtime-owned/repository',
    provider: 'runtime-owned',
    modelLevel: 'level1',
  });
  return Object.freeze({ ...input });
}

function buildHostedExecution(inputs) {
  return Object.freeze({
    graph: inputs.graph,
    input: buildLegacyShipRequest(inputs.input),
  });
}

class HostedProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'HostedProtocolError';
  }
}

class HostedTransportUncertainError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'HostedTransportUncertainError';
  }
}

class RemoteAllocationUncertainError extends Error {
  constructor(allocationIdempotencyKey, cause) {
    super(
      `remote allocation outcome is uncertain; allocation key ${allocationIdempotencyKey} was preserved. ` +
        'Do not allocate a replacement. Reconcile this exact key with the target operator.',
      { cause }
    );
    this.name = 'RemoteAllocationUncertainError';
    this.allocationIdempotencyKey = allocationIdempotencyKey;
  }
}

class RemoteDetachedError extends Error {
  constructor(capsuleId, identities, cause) {
    super(
      `remote outcome is uncertain; capsule ${capsuleId} was preserved. ` +
        `Inspect with \`zeroshot status ${capsuleId} --target <name>\` and terminate only with ` +
        `\`zeroshot capsule terminate ${capsuleId} --target <name>\`.`,
      { cause }
    );
    this.name = 'RemoteDetachedError';
    this.capsuleId = capsuleId;
    this.identities = identities;
  }
}

function stableIdentities(randomUUID, runtimeImageDigest) {
  if (!DIGEST_PATTERN.test(runtimeImageDigest)) {
    throw new Error('candidate runtime image digest is missing or invalid');
  }
  const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
  return Object.freeze({
    allocationIdempotencyKey: id('allocate'),
    applyIdempotencyKey: id('apply'),
    clientRunId: id('run'),
    runtimeImageDigest,
  });
}

function abortReason(signal) {
  return signal?.reason ?? new globalThis.DOMException('operation aborted', 'AbortError');
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function safeWatchProjection(capsuleId, item) {
  if (item.type === 'closed') {
    return {
      capsuleId,
      observation: 'closed',
      reason: item.reason,
      ...(item.lastDeliveredCursor === undefined ? {} : { cursor: item.lastDeliveredCursor }),
    };
  }
  const phase =
    item.event.type === 'phase'
      ? item.event.status.phase
      : item.event.type === 'finished'
        ? item.event.final_status.phase
        : undefined;
  return {
    capsuleId,
    runId: item.runId,
    cursor: item.cursor,
    event: item.event.type,
    ...(phase === undefined ? {} : { phase }),
  };
}

module.exports = {
  buildHostedExecution,
  buildLegacyShipRequest,
  HostedProtocolError,
  HostedTransportUncertainError,
  isDeterministicAllocationRefusal,
  RemoteAllocationUncertainError,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
