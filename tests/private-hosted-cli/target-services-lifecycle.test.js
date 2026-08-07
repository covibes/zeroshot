'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { captureLogs } = require('./candidate-fixtures');
const { targetHarness } = require('./target-service-harness');

describe('private target services', () => {
  it('runs add, login, list, setup, and remove through production service wiring', async () => {
    const h = targetHarness();
    await captureLogs(() => h.services.targetAdd('next', { url: 'https://target.example' }));
    await captureLogs(() => h.services.targetLogin('prod'));
    await captureLogs(() =>
      h.services.targetSetup('prod', {
        repository: 'owner/repository',
        provider: 'codex',
        modelLevel: 'level2',
      })
    );
    const listed = await captureLogs(() => h.services.targetList({ json: true }));
    assert.match(listed.lines[0], /"configured": true/);
    await captureLogs(() => h.services.targetRemove('prod', { force: false }));

    assert.deepEqual(h.state._targets.prod, undefined);
    assert.equal(h.state._targets.next.id, 'target-next');
    assert.equal(h.calls.filter(([name]) => name === 'login').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'revoke').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'delete').length, 1);
  });
});
