'use strict';

const { RunIntentHttpError, RunIntentTransportError } = require('./run-intent-http');
const { TERMINAL_STATES, validateRunIntent } = require('./run-intent-schema');

const RUN_INTENT_POLL_MS = 500;
const MAX_TRANSIENT_POLL_FAILURES = 3;

function abortReason(signal) {
  return (
    signal?.reason ?? new globalThis.DOMException('RunIntent observation interrupted', 'AbortError')
  );
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function transientRetryDelay(error, failures) {
  const retryable =
    error instanceof RunIntentTransportError ||
    (error instanceof RunIntentHttpError && (error.status === 429 || error.status >= 500));
  if (!retryable || failures >= MAX_TRANSIENT_POLL_FAILURES) return null;
  return RUN_INTENT_POLL_MS * 2 ** (failures + 1);
}

async function followRunIntent(client, initial, options = {}) {
  const pause = options.sleep ?? delay;
  let intent = validateRunIntent(initial);
  let displayed;
  let transientFailures = 0;
  for (;;) {
    const state = `${intent.state}:${intent.waiting_reason ?? ''}`;
    if (state !== displayed) {
      options.onChange?.(intent);
      displayed = state;
    }
    if (TERMINAL_STATES.has(intent.state)) return intent;
    await pause(RUN_INTENT_POLL_MS, options.signal);
    try {
      intent = await client.get(intent.intent_id, { signal: options.signal });
      transientFailures = 0;
    } catch (error) {
      const retryDelay = transientRetryDelay(error, transientFailures);
      if (retryDelay === null) throw error;
      transientFailures += 1;
      await pause(retryDelay, options.signal);
    }
  }
}

function displayRunIntentState(intent) {
  return intent.waiting_reason ? `${intent.state} (${intent.waiting_reason})` : intent.state;
}

module.exports = {
  MAX_TRANSIENT_POLL_FAILURES,
  displayRunIntentState,
  followRunIntent,
};
