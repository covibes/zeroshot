'use strict';

const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { describe, it } = require('node:test');
const { sleep } = require('../../private/hosted-cli-candidate/orchestrator-support');

describe('hosted orchestrator readiness sleep', () => {
  it('does not retain abort listeners after successful waits', async () => {
    const controller = new AbortController();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(0, controller.signal);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  });

  it('removes its abort listener when interrupted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const pending = sleep(60_000, controller.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);

    controller.abort(reason);

    await assert.rejects(pending, (error) => error === reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});
