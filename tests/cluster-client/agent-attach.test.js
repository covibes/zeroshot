'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { AgentAttachSubscriptionClient } = require('../../lib/cluster/cjs/index.js');
const { createHarness, successReplyFor, eventNotification } = require('./_fixtures.js');
const {
  assertCapabilityGateThrows,
  assertCapabilityGatedFirstEvent,
  describeSubscriptionContract,
} = require('./_subscription-contract.js');

const createClient = (transport) => new AgentAttachSubscriptionClient(transport);
const invoke = (client, enabled) =>
  client.agentAttach({ execution: 'exec-1' }, { agentAttach: enabled });

test('agentAttach() throws before opening any connection when capabilities.agentAttach is false', () => {
  assertCapabilityGateThrows({ createHarness, createClient, invoke });
});

test('agentAttach() delivers a first event for a capability-advertising server, cursorless', async () => {
  await assertCapabilityGatedFirstEvent({
    createHarness,
    createClient,
    invoke,
    wireMethod: 'agent/attach',
    assertRequestParams: (params) => assert.equal(params.execution, 'exec-1'),
    firstEventParams: { event: { type: 'working' } },
    assertFirstEvent: (event) => assert.deepEqual(event, { type: 'working' }),
  });
});

describeSubscriptionContract('agent/attach', {
  createHarness,
  async establish(harness) {
    const client = new AgentAttachSubscriptionClient(harness.transport);
    const promise = client.agentAttach({ execution: 'exec-1' }, { agentAttach: true });
    const requestFrame = harness.sink.frames.at(-1);
    harness.transport.routeIncoming(successReplyFor(requestFrame, { subscriptionId: 'sub-1' }));
    const { stream } = await promise;
    return { stream, subscriptionId: 'sub-1' };
  },
  pushEvent(harness, subscriptionId) {
    harness.transport.routeIncoming(
      eventNotification(subscriptionId, { event: { type: 'working' } })
    );
  },
});
