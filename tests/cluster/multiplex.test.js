/**
 * Unit tests for the generic request/subscription demultiplexer
 * (src/cluster/multiplex.ts), driven directly against a mock FrameSink so no real
 * WebSocket is involved.
 */
const assert = require('assert');
const {
  MultiplexedTransport,
  SUBSCRIPTION_QUEUE_CAPACITY,
} = require('../../lib/cluster/multiplex');
const { BoundedChannel } = require('../../lib/cluster/transport');

class MockSink {
  constructor() {
    this.sent = [];
  }

  sendFrame(frame) {
    this.sent.push(JSON.parse(frame));
    return Promise.resolve();
  }
}

describe('BoundedChannel', function () {
  it('accepts sends up to capacity and rejects further sends', function () {
    const channel = new BoundedChannel(2);
    assert.strictEqual(channel.trySend('a'), true);
    assert.strictEqual(channel.trySend('b'), true);
    assert.strictEqual(channel.trySend('c'), false);
  });

  it('delivers buffered items in FIFO order', async function () {
    const channel = new BoundedChannel(4);
    channel.trySend('a');
    channel.trySend('b');
    assert.deepStrictEqual(await channel.recv(), { done: false, value: 'a' });
    assert.deepStrictEqual(await channel.recv(), { done: false, value: 'b' });
  });

  it('delivers to an already-waiting consumer without buffering', async function () {
    const channel = new BoundedChannel(1);
    const pending = channel.recv();
    assert.strictEqual(channel.trySend('a'), true);
    assert.deepStrictEqual(await pending, { done: false, value: 'a' });
  });

  it('ends every waiting and future recv with done:true once closed', async function () {
    const channel = new BoundedChannel(1);
    const waiter = channel.recv();
    channel.close();
    assert.deepStrictEqual(await waiter, { done: true });
    assert.deepStrictEqual(await channel.recv(), { done: true });
    assert.strictEqual(channel.trySend('a'), false);
  });
});

describe('MultiplexedTransport', function () {
  it('resolves request() with the matching response line', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);

    const responsePromise = transport.request(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get', params: {} })
    );
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    );

    const line = await responsePromise;
    assert.deepStrictEqual(JSON.parse(line), { jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('rejects a request id that is already pending', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);
    const first = transport.request(
      JSON.stringify({ jsonrpc: '2.0', id: 'dup', method: 'get', params: {} })
    );
    await assert.rejects(
      transport.request(JSON.stringify({ jsonrpc: '2.0', id: 'dup', method: 'get', params: {} })),
      /already pending/
    );
    await transport.routeIncomingFrame(JSON.stringify({ jsonrpc: '2.0', id: 'dup', result: {} }));
    await first;
  });

  it('registers a subscription channel before the caller ever observes it, so a same-tick event is never dropped', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);

    const establishing = transport.openSubscription(
      JSON.stringify({ jsonrpc: '2.0', id: 'watch-1', method: 'watch', params: {} }),
      'watch-1'
    );

    // Both frames are routed before the caller ever awaits `establishing`, simulating an event
    // notification arriving in the same read-pump tick as the establishing response.
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 'watch-1', result: { subscriptionId: 'sub-1' } })
    );
    await transport.routeIncomingFrame(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { subscriptionId: 'sub-1', cursor: 'c1' },
      })
    );

    const established = await establishing;
    assert.ok(
      established.subscription,
      'a successful subscription-establishing response must carry a channel'
    );

    const item = await established.subscription.channel.recv();
    assert.strictEqual(item.done, false);
    assert.deepStrictEqual(JSON.parse(item.value), {
      jsonrpc: '2.0',
      method: 'event',
      params: { subscriptionId: 'sub-1', cursor: 'c1' },
    });
  });

  it('drops a notification for an unknown subscription id silently', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { subscriptionId: 'nonexistent' } })
    );
    assert.deepStrictEqual(sink.sent, []);
  });

  it('drops malformed / unroutable frames silently instead of throwing', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);
    await transport.routeIncomingFrame('not json');
    await transport.routeIncomingFrame(JSON.stringify({ jsonrpc: '2.0' })); // no id, no method
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 'never-pending', result: {} })
    );
    assert.deepStrictEqual(sink.sent, []);
  });

  it('sends exactly one subscription/cancel frame when the local queue overflows, and stops delivering further events', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);

    const establishing = transport.openSubscription(
      JSON.stringify({ jsonrpc: '2.0', id: 'logs-1', method: 'logs', params: {} }),
      'logs-1'
    );
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 'logs-1', result: { subscriptionId: 'sub-logs' } })
    );
    const established = await establishing;

    // Fill the channel to capacity without ever draining it, then push one more to overflow.
    for (let i = 0; i < SUBSCRIPTION_QUEUE_CAPACITY; i++) {
      await transport.routeIncomingFrame(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { subscriptionId: 'sub-logs', i },
        })
      );
    }
    await transport.routeIncomingFrame(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { subscriptionId: 'sub-logs', i: 'overflow' },
      })
    );

    assert.strictEqual(established.subscription.overflowed.value, true);
    const cancelFrames = sink.sent.filter((frame) => frame.method === 'subscription/cancel');
    assert.strictEqual(cancelFrames.length, 1);
    assert.deepStrictEqual(cancelFrames[0].params, { subscriptionId: 'sub-logs' });

    // The overflowed subscription was deregistered: a further event for it is now dropped.
    await transport.routeIncomingFrame(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { subscriptionId: 'sub-logs', i: 'late' },
      })
    );
    const cancelFramesAfter = sink.sent.filter((frame) => frame.method === 'subscription/cancel');
    assert.strictEqual(
      cancelFramesAfter.length,
      1,
      'no second cancel frame for an already-deregistered subscription'
    );
  });

  it('cancelSubscription/cancelRequest each send exactly one frame', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);
    await transport.cancelSubscription('sub-1');
    await transport.cancelRequest(7);
    assert.deepStrictEqual(sink.sent, [
      { jsonrpc: '2.0', method: 'subscription/cancel', params: { subscriptionId: 'sub-1' } },
      { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 7 } },
    ]);
  });

  it('mints sequential watch-request ids', function () {
    const transport = new MultiplexedTransport(new MockSink());
    assert.strictEqual(transport.nextWatchRequestId(), 'watch-1');
    assert.strictEqual(transport.nextWatchRequestId(), 'watch-2');
  });

  it('endStream() rejects every still-pending request and closes every open subscription channel', async function () {
    const sink = new MockSink();
    const transport = new MultiplexedTransport(sink);

    const pending = transport.request(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get', params: {} })
    );
    const establishing = transport.openSubscription(
      JSON.stringify({ jsonrpc: '2.0', id: 'watch-1', method: 'watch', params: {} }),
      'watch-1'
    );
    await transport.routeIncomingFrame(
      JSON.stringify({ jsonrpc: '2.0', id: 'watch-1', result: { subscriptionId: 'sub-1' } })
    );
    const established = await establishing;

    transport.endStream();

    await assert.rejects(pending, /server closed the connection/);
    assert.deepStrictEqual(await established.subscription.channel.recv(), { done: true });
  });
});
