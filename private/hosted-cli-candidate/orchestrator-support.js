'use strict';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
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
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
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
  HostedProtocolError,
  HostedTransportUncertainError,
  RemoteAllocationUncertainError,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
