/**
 * Coverage for the `watch` subscription client's client-side (runId, cursor) dedup and its
 * reconnect() sequencing: a coherent `get(atCursor)` snapshot followed by `watch(fromCursor)`,
 * with the dedup set carried forward across the reconnect boundary.
 */
const assert = require('assert');
const { ClusterClient } = require('../../lib/cluster/cluster-client');
const { watch } = require('../../lib/cluster/watch-subscription');
const { BoundedChannel } = require('../../lib/cluster/transport');

const EMPTY_STATUS = {
  phase: 'running',
  observedGeneration: 1,
  currentRunId: 'run-1',
  atCursor: null,
};

function eventLine(runId, cursor) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { subscriptionId: 'current', runId, cursor, event: { type: 'bookmark' } },
  });
}

/** A combined JsonRpcTransport + SubscriptionTransport: `get()` calls go through `request()`,
 * `watch()`/`reconnect()` establishments go through `openSubscription()`. Both append to a single
 * `callLog` so tests can assert cross-call ordering. */
function makeWatchTransport({ getResults, watchResults }) {
  const callLog = [];
  const channels = [];
  let watchCallIndex = 0;
  let getCallIndex = 0;
  let watchIdCounter = 1;

  const transport = {
    request: (requestJson) => {
      const request = JSON.parse(requestJson);
      callLog.push({ type: 'get', params: request.params });
      const result = getResults[getCallIndex];
      getCallIndex += 1;
      return Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    },
    openSubscription: (requestJson, id) => {
      const request = JSON.parse(requestJson);
      callLog.push({ type: 'watch', params: request.params });
      const result = watchResults[watchCallIndex];
      watchCallIndex += 1;
      const channel = new BoundedChannel(1024);
      channels.push(channel);
      return Promise.resolve({
        line: JSON.stringify({ jsonrpc: '2.0', id, result }),
        subscription: { channel, overflowed: { value: false } },
      });
    },
    cancelSubscription: () => Promise.resolve(),
    cancelRequest: () => Promise.resolve(),
    nextWatchRequestId: () => `watch-${watchIdCounter++}`,
  };

  return { transport, callLog, channels };
}

describe('watch subscription dedup', function () {
  it('suppresses a duplicate (runId,cursor) redelivery before yielding it', async function () {
    const { transport, channels } = makeWatchTransport({
      getResults: [],
      watchResults: [{ subscriptionId: 'sub-1', runId: 'run-1', atCursor: null }],
    });
    const { stream } = await watch(transport, {});
    const channel = channels[0];
    channel.trySend(eventLine('run-1', 'c1'));
    channel.trySend(eventLine('run-1', 'c1')); // legal at-least-once physical duplicate
    channel.trySend(eventLine('run-1', 'c2'));

    const first = await stream.next();
    assert.strictEqual(first.value.cursor, 'c1');
    const second = await stream.next();
    assert.strictEqual(
      second.value.cursor,
      'c2',
      'the duplicate c1 must be silently skipped, not re-yielded'
    );
  });
});

describe('watch subscription reconnect', function () {
  it('reconnect() calls get(atCursor) then watch(fromCursor) in order, and suppresses the boundary duplicate exactly once', async function () {
    const { transport, callLog, channels } = makeWatchTransport({
      getResults: [{ status: EMPTY_STATUS, atCursor: 'c2' }],
      watchResults: [
        { subscriptionId: 'sub-1', runId: 'run-1', atCursor: null },
        { subscriptionId: 'sub-2', runId: 'run-1', atCursor: 'c2' },
      ],
    });
    const clusterClient = new ClusterClient(transport);

    const { stream } = await watch(transport, {});
    const firstChannel = channels[0];
    firstChannel.trySend(eventLine('run-1', 'c1'));
    firstChannel.trySend(eventLine('run-1', 'c2'));
    await stream.next(); // c1
    await stream.next(); // c2 -- lastDeliveredCursor() is now 'c2'
    assert.strictEqual(stream.lastDeliveredCursor(), 'c2');

    const reconnected = await stream.reconnect(clusterClient);

    // callLog[0] is the initial watch() establishment above; the reconnect boundary is the last two.
    assert.strictEqual(callLog.length, 3);
    const [reconnectGet, reconnectWatch] = callLog.slice(1);
    assert.strictEqual(reconnectGet.type, 'get');
    assert.deepStrictEqual(reconnectGet.params, { atCursor: 'c2' });
    assert.strictEqual(reconnectWatch.type, 'watch');
    assert.strictEqual(reconnectWatch.params.fromCursor, 'c2');

    const secondChannel = channels[1];
    secondChannel.trySend(eventLine('run-1', 'c2')); // boundary duplicate: redelivered after reconnect
    secondChannel.trySend(eventLine('run-1', 'c3'));

    const afterReconnect = await reconnected.stream.next();
    assert.strictEqual(
      afterReconnect.value.cursor,
      'c3',
      'the boundary duplicate c2 must be suppressed exactly once, carried forward from the pre-reconnect dedup set'
    );
  });
});
