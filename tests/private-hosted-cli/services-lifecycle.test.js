'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { captureLogs, DESCRIPTOR } = require('./candidate-fixtures');
const { remoteHarness } = require('./remote-service-harness');

function registerCapsuleServiceTests() {
  it('creates, lists, and host-terminates capsules with distinct operations', async () => {
    const h = remoteHarness();
    await captureLogs(() =>
      h.services.capsuleCreate({ target: 'prod', label: 'candidate', size: 'small' })
    );
    await captureLogs(() => h.services.remoteList({ target: 'prod', limit: 7, json: true }));
    await captureLogs(() => h.services.capsuleTerminate('cap-1', { target: 'prod' }));

    const allocation = h.calls.find(([name]) => name === 'allocate')[1];
    assert.match(allocation.idempotencyKey, /^capsule_00000001/);
    assert.deepEqual(h.calls.find(([name]) => name === 'list')[1], { limit: 7 });
    assert.equal(h.calls.filter(([name]) => name === 'terminate').length, 1);
  });

  it('fails locally for unadvertised sizes and propagates known allocation refusals', async () => {
    const descriptor = {
      ...DESCRIPTOR,
      sizes: { catalog: ['tiny'], default: 'tiny' },
    };
    const local = remoteHarness({ descriptor });
    await assert.rejects(
      local.services.capsuleCreate({ target: 'prod', size: 'small' }),
      /not advertised/
    );
    assert.equal(
      local.calls.some(([name]) => name === 'allocate'),
      false
    );

    const refusal = Object.assign(new Error('Target access authorization failed'), {
      code: 'AUTH_FAILED',
    });
    const rejected = remoteHarness({ allocationError: refusal });
    await assert.rejects(
      rejected.services.capsuleCreate({ target: 'prod' }),
      (error) => error === refusal
    );
  });
}

function registerRemoteOperationTests() {
  it('reports remote status and keeps drain/force stop separate from host termination', async () => {
    const h = remoteHarness();
    await captureLogs(() => h.services.remoteStatus('cap-1', { target: 'prod', json: true }));
    await captureLogs(() => h.services.remoteStop('cap-1', { target: 'prod', force: false }));
    await captureLogs(() => h.services.remoteStop('cap-1', { target: 'prod', force: true }));

    const stops = h.calls.filter(([name]) => name === 'stop').map(([, params]) => params);
    assert.deepEqual(
      stops.map(({ mode, ifGeneration }) => ({ mode, ifGeneration })),
      [
        { mode: 'drain', ifGeneration: 3 },
        { mode: 'force', ifGeneration: 3 },
      ]
    );
    assert.equal(
      h.calls.some(([name]) => name === 'terminate'),
      false
    );
  });
}

describe('private capsule services', () => {
  registerCapsuleServiceTests();
  registerRemoteOperationTests();
});
