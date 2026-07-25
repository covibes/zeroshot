'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { LogsSubscriptionClient } = require('../../lib/cluster/cjs/index.js');
const { createHarness, successReplyFor, eventNotification } = require('./_fixtures.js');
const {
  assertCapabilityGateThrows,
  assertCapabilityGatedFirstEvent,
  describeSubscriptionContract,
} = require('./_subscription-contract.js');

const createClient = (transport) => new LogsSubscriptionClient(transport);
const invoke = (client, enabled) => client.logs({}, { logs: enabled });

test('logs() throws before opening any connection when capabilities.logs is false', () => {
  assertCapabilityGateThrows({ createHarness, createClient, invoke });
});

test('logs() delivers a first event for a capability-advertising server, cursorless', async () => {
  await assertCapabilityGatedFirstEvent({
    createHarness,
    createClient,
    invoke,
    wireMethod: 'logs',
    firstEventParams: { record: { level: 'info', target: 'worker', message: 'hello' } },
    assertFirstEvent: (event) =>
      assert.deepEqual(event, { level: 'info', target: 'worker', message: 'hello' }),
  });
});

describeSubscriptionContract('logs', {
  createHarness,
  async establish(harness) {
    const client = new LogsSubscriptionClient(harness.transport);
    const promise = client.logs({}, { logs: true });
    const requestFrame = harness.sink.frames.at(-1);
    harness.transport.routeIncoming(successReplyFor(requestFrame, { subscriptionId: 'sub-1' }));
    const { stream } = await promise;
    return { stream, subscriptionId: 'sub-1' };
  },
  pushEvent(harness, subscriptionId, n) {
    harness.transport.routeIncoming(
      eventNotification(subscriptionId, {
        record: { level: 'info', target: 'worker', message: `m${n}` },
      })
    );
  },
});
