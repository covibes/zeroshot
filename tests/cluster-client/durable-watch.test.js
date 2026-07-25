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

function snapshotReply(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      spec: null,
      status: { phase: 'running', observedGeneration: 1, currentRunId: 'run-1', atCursor: 'c1' },
      atCursor: 'c1',
    },
  };
}

/**
 * Scripts a fake server where every socket after the first (i.e. every reconnect attempt) fails
 * its `get()` call with a well-formed JSON-RPC error — the socket itself stays open (readyState
 * OPEN), so only the client proactively closing the fresh transport on failure (not the peer
 * dying) can account for it ending up closed.
 */
function reconnectGetRpcErrorServer() {
  const socketIndex = new WeakMap();
  let nextIndex = 0;
  return (request, socket) => {
    if (!socketIndex.has(socket)) {
      nextIndex += 1;
      socketIndex.set(socket, nextIndex);
    }
    const connIndex = socketIndex.get(socket);
    if (request.method === 'get') {
      if (connIndex > 1) {
        return {
          reply: {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: 'snapshot temporarily unavailable' },
          },
        };
      }
      return { reply: snapshotReply(request.id) };
    }
    if (request.method === 'watch') {
      return {
        reply: {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            subscriptionId: `sub-${connIndex}`,
            runId: 'run-1',
            atCursor: request.params.fromCursor ?? null,
          },
        },
      };
    }
    return null;
  };
}

// AC3(a): if the reconnect's get() call errors after the fresh transport connects, the fresh
// transport must be closed (never installed) and the reconnect attempt must propagate as a
// rejection rather than hanging or silently swallowing the failure — even though the peer never
// dropped the fresh socket itself, so only the client's own cleanup can close it.
test('reconnect failure during get() closes the fresh socket and rejects next()', async () => {
  const { factory, sockets } = createWebSocketFactory(reconnectGetRpcErrorServer());
  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    { webSocketFactory: factory }
  );
  const [firstSocket] = sockets;

  firstSocket.simulateDisconnect();

  await assert.rejects(() => durable.next());

  assert.equal(
    sockets.length,
    2,
    'exactly one fresh socket must be dialed for the reconnect attempt'
  );
  const [, freshSocket] = sockets;
  assert.equal(
    freshSocket.readyState,
    3,
    'the fresh socket must end up closed, never installed as the live transport'
  );
});

// AC3(b): close() racing a reconnect that is gated mid-flight (get() sent but not yet replied)
// must win — the fresh transport must never be installed, must never see a `watch` frame, and
// must end up closed once the gate is released.
test('close() racing a gated reconnect wins: the fresh socket is never installed', async () => {
  let watchCounter = 0;
  let gatedGet = null;
  const socketIndex = new WeakMap();
  let nextIndex = 0;

  const respond = (request, socket) => {
    if (!socketIndex.has(socket)) {
      nextIndex += 1;
      socketIndex.set(socket, nextIndex);
    }
    const connIndex = socketIndex.get(socket);
    if (request.method === 'get') {
      if (connIndex > 1) {
        gatedGet = { id: request.id, socket };
        return null; // gate: no reply until the test manually delivers one
      }
      return { reply: snapshotReply(request.id) };
    }
    if (request.method === 'watch') {
      watchCounter += 1;
      const subscriptionId = `sub-${watchCounter}`;
      socket.subscriptionId = subscriptionId;
      return {
        reply: {
          jsonrpc: '2.0',
          id: request.id,
          result: { subscriptionId, runId: 'run-1', atCursor: request.params.fromCursor ?? null },
        },
      };
    }
    return null;
  };

  const { factory, sockets } = createWebSocketFactory(respond);
  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    { webSocketFactory: factory }
  );
  const [firstSocket] = sockets;

  firstSocket.simulateDisconnect();
  const pendingNext = durable.next();

  for (let i = 0; i < 50 && !gatedGet; i += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  assert.ok(gatedGet, 'the reconnect must have issued its gated get() request');
  assert.equal(
    sockets.length,
    2,
    'exactly one fresh socket must be dialed for the reconnect attempt'
  );
  const freshSocket = sockets[1];

  // close() races the in-flight, gated reconnect. Cancelling the subscription over the
  // already-dead original transport is a pre-existing, out-of-scope failure mode here (the
  // original socket died to trigger this reconnect in the first place) — only `this.closing`
  // being set synchronously, before any await, matters for this invariant.
  await durable.close().catch(() => {});

  // Release the gate now that close() has already run.
  gatedGet.socket._emit('message', { data: JSON.stringify(snapshotReply(gatedGet.id)) });

  assert.equal(await pendingNext, null, 'next() must resolve null once close() wins the race');

  assert.equal(freshSocket.readyState, 3, 'the fresh socket must end up closed, never left live');
  const freshMethods = freshSocket.sent.map((frame) => JSON.parse(frame).method);
  assert.deepEqual(
    freshMethods,
    ['get'],
    'the fresh transport must never see watch after close() wins the race'
  );
});

// AC4: two next() calls issued without awaiting the first, both observing a disconnected stream,
// must share exactly one in-flight reconnect attempt rather than each dialing a fresh socket.
test('concurrent next() calls observed while disconnected share exactly one in-flight reconnect', async () => {
  const { factory, sockets } = createWebSocketFactory(scriptedServer());
  const durable = await DurableWatchClient.connect(
    'ws://fake-cluster',
    { runId: 'run-1' },
    { webSocketFactory: factory }
  );
  const [firstSocket] = sockets;

  firstSocket.simulateDisconnect();

  // Let the disconnect fully propagate — the subscription queue must actually be closed
  // (multiplexed.finish() has run), not just the socket's readyState flipped — before issuing both
  // next() calls. Otherwise the first call claims the queue's single-waiter slot and the second
  // rejects immediately via AC5's guard without ever reaching the reconnect logic this test targets.
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }

  const firstPromise = durable.next();
  const secondPromise = durable.next();
  // The underlying subscription queue is a single-consumer primitive (see AC5): once the shared
  // reconnect resolves, at most one of these two calls can consume from the resulting stream. This
  // test only asserts the reconnect dial itself is shared, not that both calls independently
  // observe an event, so any rejection from the losing call is expected and swallowed.
  firstPromise.catch(() => {});
  secondPromise.catch(() => {});

  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }

  assert.equal(
    sockets.length,
    2,
    'exactly one fresh socket must be dialed for both concurrent next() calls, not two'
  );

  await durable.close().catch(() => {});
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
