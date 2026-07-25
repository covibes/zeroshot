'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { WatchSubscriptionClient } = require('../../lib/cluster/cjs/index.js');
const { createHarness, parseFrame, successReplyFor, eventNotification } = require('./_fixtures.js');
const { describeSubscriptionContract } = require('./_subscription-contract.js');

function sampleEvent() {
  return { type: 'node_begin', node: { node: 'worker', attempt: 1 }, input: { kind: 'null' } };
}

function establish(harness, params = {}) {
  const { transport } = harness;
  const client = new WatchSubscriptionClient(transport);
  const promise = client.watch(params);
  const requestFrame = harness.sink.frames.at(-1);
  transport.routeIncoming(
    successReplyFor(requestFrame, { subscriptionId: 'sub-1', runId: 'run-1' })
  );
  return promise;
}

test('delivers events in order and exposes lastDeliveredCursor/currentRunId', async () => {
  const harness = createHarness();
  const { stream } = await establish(harness);

  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );
  const first = await stream.next();
  assert.equal(first.type, 'event');
  assert.equal(first.cursor, 'c1');
  assert.equal(stream.lastDeliveredCursor(), 'c1');
  assert.equal(stream.currentRunId(), 'run-1');
});

test('dedups a legally redelivered (runId, cursor) pair', async () => {
  const harness = createHarness();
  const { stream } = await establish(harness);

  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );
  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );
  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c2', event: sampleEvent() })
  );

  const first = await stream.next();
  assert.equal(first.cursor, 'c1');
  const second = await stream.next();
  assert.equal(second.cursor, 'c2', 'the duplicate c1 delivery must be silently dropped');
});

test('subscription-level reconnect carries the dedup set across the same live transport', async () => {
  const harness = createHarness();
  const { stream } = await establish(harness);

  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );
  const first = await stream.next();
  assert.equal(first.cursor, 'c1');

  const reconnectPromise = stream.reconnect();
  const reconnectFrame = harness.sink.frames.at(-1);
  const reconnectRequest = parseFrame(reconnectFrame);
  assert.equal(reconnectRequest.method, 'watch');
  assert.equal(reconnectRequest.params.fromCursor, 'c1');
  assert.equal(reconnectRequest.params.runId, 'run-1');

  harness.transport.routeIncoming(
    successReplyFor(reconnectFrame, { subscriptionId: 'sub-2', runId: 'run-1' })
  );
  const { stream: reconnected } = await reconnectPromise;

  // Legal at-least-once redelivery of c1 on the new subscription, then a genuinely new c2.
  harness.transport.routeIncoming(
    eventNotification('sub-2', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );
  harness.transport.routeIncoming(
    eventNotification('sub-2', { runId: 'run-1', cursor: 'c2', event: sampleEvent() })
  );
  const next = await reconnected.next();
  assert.equal(next.cursor, 'c2', 'dedup set must survive the reconnect boundary');
});

// AC5 (overflow -> exactly one SLOW_CONSUMER close) and AC6 (iterator return() -> exactly one
// cancel) are the same contract watch/logs/agent-attach all share; see _subscription-contract.js.
describeSubscriptionContract('watch', {
  createHarness,
  async establish(harness) {
    const { stream } = await establish(harness);
    return { stream, subscriptionId: 'sub-1' };
  },
  pushEvent(harness, subscriptionId, n) {
    harness.transport.routeIncoming(
      eventNotification(subscriptionId, { runId: 'run-1', cursor: `c${n}`, event: sampleEvent() })
    );
  },
});

test('a terminal "done" close ends a for-await loop without hanging', async () => {
  const harness = createHarness();
  const { stream } = await establish(harness);

  harness.transport.routeIncoming(
    eventNotification('sub-1', { runId: 'run-1', cursor: 'c1', event: sampleEvent() })
  );

  const seen = [];
  const notifyClosed = () =>
    harness.transport.routeIncoming(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscription/closed',
        params: { subscriptionId: 'sub-1', reason: 'done', lastDeliveredCursor: 'c1' },
      })
    );

  let iterations = 0;
  for await (const outcome of stream) {
    seen.push(outcome);
    iterations += 1;
    if (iterations === 1) notifyClosed();
    if (iterations > 5) throw new Error('for-await loop did not terminate after a done close');
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'event');
  assert.equal(seen[1].type, 'closed');
  assert.equal(seen[1].reason, 'done');
});
