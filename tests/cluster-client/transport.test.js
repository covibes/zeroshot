'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  requestIdKey,
  BoundedSubscriptionQueue,
  ClusterTransportError,
} = require('../../lib/cluster/cjs/index.js');
const { createHarness, parseFrame, successReplyFor } = require('./_fixtures.js');

// AC2: two callers sharing one MultiplexedTransport must never allocate colliding request ids,
// even when their sendRequest calls are issued concurrently and resolved out of order. Run
// deterministically across 3 repeated rounds per the plan's verification note.
for (let round = 1; round <= 3; round += 1) {
  test(`shared transport never collides request ids under concurrent load (round ${round})`, async () => {
    const { sink, transport } = createHarness();
    const callerACount = 25;
    const callerBCount = 25;

    function fireCalls(count) {
      const promises = [];
      for (let i = 0; i < count; i += 1) {
        const id = transport.nextRequestId();
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method: 'get', params: {} });
        promises.push(transport.sendRequest(frame, id));
      }
      return promises;
    }

    const pendingA = fireCalls(callerACount);
    const pendingB = fireCalls(callerBCount);

    const sentIds = sink.frames.map((frame) => parseFrame(frame).id);
    const uniqueKeys = new Set(sentIds.map((id) => requestIdKey(id)));
    assert.equal(uniqueKeys.size, sentIds.length, 'every allocated request id must be unique');
    assert.equal(sentIds.length, callerACount + callerBCount);

    // Resolve out of order (reverse) to prove routing is id-keyed, not order-dependent.
    for (const frame of [...sink.frames].reverse()) {
      transport.routeIncoming(successReplyFor(frame, { ok: true }));
    }

    const results = await Promise.all([...pendingA, ...pendingB]);
    assert.equal(results.length, callerACount + callerBCount);
    for (const response of results) {
      assert.equal(parseFrame(response.line).result.ok, true);
    }
    assert.equal(transport.pendingSize, 0);
  });
}

// AC4: a failed writeFrame() on a closed transport must remove/reject exactly its own pending
// entry and leave the pending map empty, without disturbing unrelated in-flight calls.
test('a failed sendFrame removes only its own pending entry and leaves unrelated calls intact', async () => {
  const { sink, transport } = createHarness();

  const goodId = transport.nextRequestId();
  const goodFrame = JSON.stringify({ jsonrpc: '2.0', id: goodId, method: 'get', params: {} });
  const goodPromise = transport.sendRequest(goodFrame, goodId);
  assert.equal(transport.pendingSize, 1);

  sink.failNextSends(1);
  const failingId = transport.nextRequestId();
  const failingFrame = JSON.stringify({ jsonrpc: '2.0', id: failingId, method: 'get', params: {} });

  await assert.rejects(
    () => transport.sendRequest(failingFrame, failingId),
    /WebSocket is not open/
  );
  assert.equal(transport.pendingSize, 1, 'the failed send must not leave a pending entry behind');

  transport.routeIncoming(successReplyFor(goodFrame, { ok: true }));
  const goodResponse = await goodPromise;
  assert.equal(parseFrame(goodResponse.line).result.ok, true);
  assert.equal(
    transport.pendingSize,
    0,
    'pending map must be empty once the only real call settles'
  );
});

test('repeated failed sends on a closed transport leave pending state empty every time', async () => {
  const { sink, transport } = createHarness();
  sink.failNextSends(5);

  for (let i = 0; i < 5; i += 1) {
    const id = transport.nextRequestId();
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method: 'get', params: {} });
    await assert.rejects(() => transport.sendRequest(frame, id));
    assert.equal(transport.pendingSize, 0);
  }
});

test('rejects a duplicate request id registered while the first is still pending', async () => {
  const { transport } = createHarness();
  const id = transport.nextRequestId();
  const frame = JSON.stringify({ jsonrpc: '2.0', id, method: 'get', params: {} });
  const first = transport.sendRequest(frame, id);
  await assert.rejects(() => transport.sendRequest(frame, id), /already pending/);
  transport.finish();
  await assert.rejects(() => first);
});

test('nextWatchRequestId mints distinct watch-<n> ids shared across callers', () => {
  const { transport } = createHarness();
  const ids = new Set();
  for (let i = 0; i < 10; i += 1) {
    const id = transport.nextWatchRequestId();
    assert.match(String(id), /^watch-\d+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 10);
});

// AC5: BoundedSubscriptionQueue.recv() must never silently drop a concurrent waiter — Rust's
// mpsc::Receiver is not Clone, so a second concurrent recv() fails fast rather than overwriting
// the first caller's pending resolver.
test('a second concurrent recv() throws synchronously and does not lose the first waiter', async () => {
  const queue = new BoundedSubscriptionQueue();

  const first = queue.recv();
  assert.throws(
    () => queue.recv(),
    ClusterTransportError,
    'concurrent recv() calls on the same subscription queue are not supported'
  );

  assert.equal(queue.tryPush('x'), 'ok');
  assert.equal(await first, 'x', 'the first waiter must still resolve once a line is pushed');
});

test('finish() rejects every pending call and ends every open subscription queue', async () => {
  const { transport } = createHarness();
  const id = transport.nextRequestId();
  const frame = JSON.stringify({ jsonrpc: '2.0', id, method: 'watch', params: {} });
  const pending = transport.sendRequest(frame, id);
  transport.routeIncoming(successReplyFor(frame, { subscriptionId: 'sub-1' }));
  const response = await pending;
  assert.ok(response.queue);

  const secondId = transport.nextRequestId();
  const secondFrame = JSON.stringify({ jsonrpc: '2.0', id: secondId, method: 'get', params: {} });
  const secondPending = transport.sendRequest(secondFrame, secondId);

  transport.finish();

  await assert.rejects(() => secondPending, /connection closed/);
  assert.equal(await response.queue.recv(), null);
  assert.equal(transport.pendingSize, 0);
});
