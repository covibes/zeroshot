'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { DurableWatchClient } = require('../../lib/cluster/cjs/index.js');
const { createWebSocketFactory } = require('./_fake-websocket.js');

function watchEventFrame(subscriptionId, runId, cursor) {
  return {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      subscriptionId,
      runId,
      cursor,
      event: { type: 'node_begin', node: { node: 'worker', attempt: 1 }, input: { kind: 'null' } },
    },
  };
}

/**
 * Scripts a fake cluster server: `get` always replies with a coherent snapshot; `watch`
 * establishes a fresh subscription id and, only on a *reconnect* (`fromCursor` present), replays
 * the cursor it was reconnected from once (legal at-least-once redelivery the client must dedup)
 * before delivering a genuinely new one.
 */
function scriptedServer() {
  let watchCounter = 0;
  return (request, socket) => {
    if (request.method === 'get') {
      return {
        reply: {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            spec: null,
            status: {
              phase: 'running',
              observedGeneration: 1,
              currentRunId: 'run-1',
              atCursor: 'c1',
            },
            atCursor: 'c1',
          },
        },
      };
    }
    if (request.method === 'watch') {
      watchCounter += 1;
      const subscriptionId = `sub-${watchCounter}`;
      socket.subscriptionId = subscriptionId;
      const fromCursor = request.params.fromCursor ?? null;
      const reply = {
        jsonrpc: '2.0',
        id: request.id,
        result: { subscriptionId, runId: 'run-1', atCursor: fromCursor },
      };
      const after =
        fromCursor === null
          ? undefined
          : (s) => {
              s.push(watchEventFrame(subscriptionId, 'run-1', fromCursor));
              s.push(watchEventFrame(subscriptionId, 'run-1', 'c2'));
            };
      return { reply, after };
    }
    return null; // $/cancelRequest / subscription/cancel notifications need no reply
  };
}

test('reconnect issues get()+watch(fromCursor) exclusively on the freshly dialed transport', async () => {
  const { factory, sockets } = createWebSocketFactory(scriptedServer());

  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    {
      webSocketFactory: factory,
    }
  );
  assert.equal(sockets.length, 1);
  const [firstSocket] = sockets;

  firstSocket.push(watchEventFrame(firstSocket.subscriptionId, 'run-1', 'c1'));
  const firstEvent = await durable.next();
  assert.equal(firstEvent.type, 'event');
  assert.equal(firstEvent.cursor, 'c1');

  firstSocket.simulateDisconnect();

  const secondEvent = await durable.next();
  assert.equal(secondEvent.type, 'event');
  assert.equal(secondEvent.cursor, 'c2', 'the redelivered c1 must be deduped, only c2 is new');

  assert.equal(sockets.length, 2, 'reconnect must dial exactly one fresh WebSocket');
  const [oldSocket, newSocket] = sockets;

  const oldMethods = oldSocket.sent.map((frame) => JSON.parse(frame).method);
  assert.deepEqual(
    oldMethods,
    ['watch'],
    'the closed transport must never see get/watch again after reconnect'
  );

  const newMethods = newSocket.sent.map((frame) => JSON.parse(frame).method);
  assert.deepEqual(
    newMethods,
    ['get', 'watch'],
    'the fresh transport must see a coherent get() then watch()'
  );

  const newWatchRequest = JSON.parse(newSocket.sent[1]);
  assert.equal(newWatchRequest.params.runId, 'run-1');
  assert.equal(newWatchRequest.params.fromCursor, 'c1');

  await durable.close();
});

test('DurableWatchClient is directly usable with for-await and closes exactly once on break', async () => {
  const { factory, sockets } = createWebSocketFactory(scriptedServer());
  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    {
      webSocketFactory: factory,
    }
  );
  const [socket] = sockets;
  socket.push(watchEventFrame(socket.subscriptionId, 'run-1', 'c1'));

  // eslint-disable-next-line no-unreachable-loop -- intentional single-pass break: exercises AC6's async-iterator return() cleanup
  for await (const outcome of durable) {
    assert.equal(outcome.type, 'event');
    break;
  }

  await durable.close(); // idempotent: must not send a second subscription/cancel or re-close
  const cancelFrames = socket.sent.filter(
    (frame) => JSON.parse(frame).method === 'subscription/cancel'
  );
  assert.equal(cancelFrames.length, 1);
});

test('close() is idempotent and does not attempt to reconnect a locally-closed client', async () => {
  const { factory, sockets } = createWebSocketFactory(scriptedServer());
  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    {
      webSocketFactory: factory,
    }
  );

  await durable.close();
  await durable.close();

  assert.equal(sockets.length, 1, 'a locally-initiated close must never trigger a reconnect');
  const cancelFrames = sockets[0].sent.filter(
    (frame) => JSON.parse(frame).method === 'subscription/cancel'
  );
  assert.equal(cancelFrames.length, 1);

  assert.equal(await durable.next(), null);
});
