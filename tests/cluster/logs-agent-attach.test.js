/**
 * Coverage for the `logs`/`agent/attach` subscription clients: no cursor/runId ever appears at
 * runtime, no reconnection is attempted, and cancel()/async-iterator return() each send exactly
 * one `subscription/cancel` frame even under concurrent double-cancel.
 */
const assert = require('assert');
const { logs } = require('../../lib/cluster/logs-subscription');
const { agentAttach } = require('../../lib/cluster/agent-attach-subscription');
const { BoundedChannel } = require('../../lib/cluster/transport');

function makeSubscriptionTransport({ result }) {
  const cancelSubscriptionCalls = [];
  let watchIdCounter = 1;
  let channel;
  const transport = {
    request: () => Promise.reject(new Error('unused in this test')),
    openSubscription: (requestJson, id) => {
      channel = new BoundedChannel(1024);
      return Promise.resolve({
        line: JSON.stringify({ jsonrpc: '2.0', id, result }),
        subscription: { channel, overflowed: { value: false } },
      });
    },
    cancelSubscription: (subscriptionId) => {
      cancelSubscriptionCalls.push(subscriptionId);
      return Promise.resolve();
    },
    cancelRequest: () => Promise.resolve(),
    nextWatchRequestId: () => `watch-${watchIdCounter++}`,
  };
  return { transport, cancelSubscriptionCalls, getChannel: () => channel };
}

describe('logs subscription', function () {
  it('the establishment result carries no cursor or runId field', async function () {
    const { transport } = makeSubscriptionTransport({ result: { subscriptionId: 'sub-1' } });
    const { result } = await logs(transport, {});
    assert.deepStrictEqual(Object.keys(result).sort(), ['subscriptionId']);
    assert.ok(!('cursor' in result));
    assert.ok(!('runId' in result));
  });

  it('a delivered log record carries no cursor or runId field', async function () {
    const { transport, getChannel } = makeSubscriptionTransport({
      result: { subscriptionId: 'sub-1' },
    });
    const { stream } = await logs(transport, {});
    getChannel().trySend(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { subscriptionId: 'sub-1', record: { level: 'info', target: 't', message: 'm' } },
      })
    );
    const item = await stream.next();
    assert.strictEqual(item.value.kind, 'event');
    assert.deepStrictEqual(Object.keys(item.value.event).sort(), ['level', 'message', 'target']);
  });

  it('cancel()/return() send exactly one subscription/cancel frame even under concurrent double-cancel', async function () {
    const { transport, cancelSubscriptionCalls } = makeSubscriptionTransport({
      result: { subscriptionId: 'sub-1' },
    });
    const { stream } = await logs(transport, {});
    await Promise.all([stream.cancel(), stream.cancel(), stream.return()]);
    assert.strictEqual(cancelSubscriptionCalls.length, 1);
    assert.deepStrictEqual(cancelSubscriptionCalls, ['sub-1']);
  });

  it('closing with reason "done" never implies reconnection -- the stream simply ends after the closed item', async function () {
    const { transport, getChannel } = makeSubscriptionTransport({
      result: { subscriptionId: 'sub-1' },
    });
    const { stream } = await logs(transport, {});
    getChannel().trySend(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscription/closed',
        params: { subscriptionId: 'sub-1', reason: 'done' },
      })
    );
    getChannel().close();
    const closed = await stream.next();
    assert.deepStrictEqual(closed.value, { kind: 'closed', reason: 'done' });
    const done = await stream.next();
    assert.strictEqual(done.done, true);
  });
});

describe('agent/attach subscription', function () {
  it('the establishment result carries no cursor or runId field', async function () {
    const { transport } = makeSubscriptionTransport({ result: { subscriptionId: 'sub-1' } });
    const { result } = await agentAttach(transport, { execution: 'exec-1' });
    assert.deepStrictEqual(Object.keys(result).sort(), ['subscriptionId']);
    assert.ok(!('cursor' in result));
    assert.ok(!('runId' in result));
  });

  it('a delivered event carries no cursor or runId field', async function () {
    const { transport, getChannel } = makeSubscriptionTransport({
      result: { subscriptionId: 'sub-1' },
    });
    const { stream } = await agentAttach(transport, { execution: 'exec-1' });
    getChannel().trySend(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { subscriptionId: 'sub-1', event: { type: 'output', text: 'hello' } },
      })
    );
    const item = await stream.next();
    assert.strictEqual(item.value.kind, 'event');
    assert.deepStrictEqual(item.value.event, { type: 'output', text: 'hello' });
  });

  it('cancel()/return() send exactly one subscription/cancel frame even under concurrent double-cancel', async function () {
    const { transport, cancelSubscriptionCalls } = makeSubscriptionTransport({
      result: { subscriptionId: 'sub-1' },
    });
    const { stream } = await agentAttach(transport, { execution: 'exec-1' });
    await Promise.all([stream.return(), stream.cancel(), stream.cancel()]);
    assert.strictEqual(cancelSubscriptionCalls.length, 1);
  });
});
