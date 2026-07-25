'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { parseFrame, successReplyFor, eventNotification } = require('./_fixtures.js');
const { CapabilityNotSupportedError } = require('../../lib/cluster/cjs/index.js');

/**
 * Asserts the capability-gate half of the contract shared by cursorless subscriptions (`logs`,
 * `agent/attach`): calling the method with its capability disabled throws before any frame is sent.
 * Callers wrap this in their own `test(...)` so each file keeps its own test registration.
 */
function assertCapabilityGateThrows({ createHarness, createClient, invoke }) {
  const { transport, sink } = createHarness();
  const client = createClient(transport);

  assert.throws(() => invoke(client, false), CapabilityNotSupportedError);
  assert.equal(sink.frames.length, 0, 'a capability-gated rejection must not send any frame');
}

/**
 * Asserts the round-trip half of the contract shared by cursorless subscriptions (`logs`,
 * `agent/attach`): calling the method with its capability enabled sends `wireMethod`, then
 * delivers a first event through the client's typed stream. Callers wrap this in their own
 * `test(...)` so each file keeps its own test registration.
 */
async function assertCapabilityGatedFirstEvent({
  createHarness,
  createClient,
  invoke,
  wireMethod,
  assertRequestParams,
  firstEventParams,
  assertFirstEvent,
}) {
  const { transport, sink } = createHarness();
  const client = createClient(transport);

  const promise = invoke(client, true);
  const requestFrame = sink.frames.at(-1);
  const request = parseFrame(requestFrame);
  assert.equal(request.method, wireMethod);
  assertRequestParams?.(request.params);

  transport.routeIncoming(successReplyFor(requestFrame, { subscriptionId: 'sub-1' }));
  const { result, stream } = await promise;
  assert.equal(result.subscriptionId, 'sub-1');

  transport.routeIncoming(eventNotification('sub-1', firstEventParams));
  const outcome = await stream.next();
  assert.equal(outcome.type, 'event');
  assertFirstEvent(outcome.event);
}

/**
 * The subscription-lifecycle contract shared by `logs`/`agent-attach`/`watch` (AC5's local
 * overflow -> exactly one SLOW_CONSUMER close, and AC6's iterator-return -> exactly one cancel).
 * `establish(harness)` opens a subscription and returns `{ stream, subscriptionId }`.
 * `pushEvent(harness, subscriptionId, n)` delivers one distinguishable `event` notification.
 */
function describeSubscriptionContract(label, { createHarness, establish, pushEvent }) {
  test(`${label}: local overflow surfaces exactly one SLOW_CONSUMER close then ends`, async () => {
    const harness = createHarness({ subscriptionQueueCapacity: 1 });
    const { stream, subscriptionId } = await establish(harness);
    pushEvent(harness, subscriptionId, 0);
    pushEvent(harness, subscriptionId, 1);

    const first = await stream.next();
    assert.equal(first.type, 'event');
    const closed = await stream.next();
    assert.equal(closed.type, 'closed');
    assert.equal(closed.reason, 'SLOW_CONSUMER');
    assert.equal(
      await stream.next(),
      null,
      'iteration must end after the single SLOW_CONSUMER close'
    );

    const cancelSent = harness.sink.frames.some((frame) => {
      const parsed = parseFrame(frame);
      return (
        parsed.method === 'subscription/cancel' && parsed.params.subscriptionId === subscriptionId
      );
    });
    assert.ok(cancelSent, 'overflow must best-effort cancel the server-side subscription');
  });

  test(`${label}: breaking a for-await loop cancels the subscription exactly once`, async () => {
    const harness = createHarness();
    const { stream, subscriptionId } = await establish(harness);
    pushEvent(harness, subscriptionId, 0);

    // eslint-disable-next-line no-unreachable-loop -- intentional single-pass break: exercises AC6's async-iterator return() cleanup
    for await (const outcome of stream) {
      assert.equal(outcome.type, 'event');
      break;
    }
    await stream.cancel(); // idempotent: the implicit iterator-return cancel already fired

    const cancelFrames = harness.sink.frames.filter(
      (frame) => parseFrame(frame).method === 'subscription/cancel'
    );
    assert.equal(cancelFrames.length, 1);
  });
}

module.exports = {
  assertCapabilityGateThrows,
  assertCapabilityGatedFirstEvent,
  describeSubscriptionContract,
};
