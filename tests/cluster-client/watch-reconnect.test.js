'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterClient,
  ConnectionMultiplexer,
  establishWatch,
} = require('../../lib/cluster/cjs/index.js');
const {
  createFakeSocketPair,
  respondSuccess,
  notify,
  waitForRequest,
} = require('./fake-websocket.js');

test('reconnect() re-establishes through the fresh client, never the stale transport, and dedups the boundary event', async () => {
  const orig = createFakeSocketPair();
  const fresh = createFakeSocketPair();

  const origTransport = new ConnectionMultiplexer(orig.client);
  const freshTransport = new ConnectionMultiplexer(fresh.client);
  const freshClient = new ClusterClient(freshTransport);

  const establishPromise = establishWatch(origTransport, { runId: null, fromCursor: null });
  const establishRequest = await waitForRequest(orig.server, 'watch');
  respondSuccess(orig.server, establishRequest.id, {
    subscriptionId: 'sub-1',
    runId: 'run-1',
    atCursor: 'cursor-0',
  });
  const stream = await establishPromise;

  notify(orig.server, 'event', {
    subscriptionId: 'sub-1',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.cursor, 'cursor-1');
  assert.equal(stream.lastDeliveredCursor, 'cursor-1');

  // Force-close the original connection -- the reconnect must never touch it again.
  orig.client.close();
  const sentBeforeReconnect = orig.client.sent.length;

  const reconnectPromise = stream.reconnect(freshClient);
  const reconnectRequest = await waitForRequest(fresh.server, 'watch');
  assert.equal(reconnectRequest.params.runId, 'run-1');
  assert.equal(
    reconnectRequest.params.fromCursor,
    'cursor-1',
    'must replay from last DELIVERED cursor, not the establishment atCursor'
  );
  respondSuccess(fresh.server, reconnectRequest.id, {
    subscriptionId: 'sub-2',
    runId: 'run-1',
    atCursor: 'cursor-1',
  });
  const reconnected = await reconnectPromise;

  // Redeliver the exact boundary event the original stream already admitted, plus a new one.
  notify(fresh.server, 'event', {
    subscriptionId: 'sub-2',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  notify(fresh.server, 'event', {
    subscriptionId: 'sub-2',
    runId: 'run-1',
    cursor: 'cursor-2',
    event: { type: 'bookmark' },
  });

  const reconnectedIterator = reconnected[Symbol.asyncIterator]();
  const next = await reconnectedIterator.next();
  assert.equal(next.done, false);
  assert.equal(
    next.value.cursor,
    'cursor-2',
    'the redelivered cursor-1 boundary event must be suppressed by dedup'
  );

  assert.equal(
    orig.client.sent.length,
    sentBeforeReconnect,
    'reconnect must not send anything on the original (closed) transport'
  );
});

test('reconnect() before any event was delivered falls back to the establishment atCursor', async () => {
  const orig = createFakeSocketPair();
  const fresh = createFakeSocketPair();
  const origTransport = new ConnectionMultiplexer(orig.client);
  const freshTransport = new ConnectionMultiplexer(fresh.client);
  const freshClient = new ClusterClient(freshTransport);

  const establishPromise = establishWatch(origTransport, { runId: 'run-1', fromCursor: null });
  const establishRequest = await waitForRequest(orig.server, 'watch');
  respondSuccess(orig.server, establishRequest.id, {
    subscriptionId: 'sub-1',
    runId: 'run-1',
    atCursor: 'cursor-0',
  });
  const stream = await establishPromise;

  orig.client.close();

  const reconnectPromise = stream.reconnect(freshClient);
  const reconnectRequest = await waitForRequest(fresh.server, 'watch');
  assert.equal(reconnectRequest.params.fromCursor, 'cursor-0');
  respondSuccess(fresh.server, reconnectRequest.id, { subscriptionId: 'sub-2', runId: 'run-1' });
  await reconnectPromise;
});
