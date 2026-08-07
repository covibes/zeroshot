'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createTempDirectory, removeTempDirectory } = require('../helpers/temp-directory');
const { BASE_REVISION, captureLogs, RUNTIME_CONFIG } = require('./candidate-fixtures');
const { targetHarness } = require('./target-service-harness');

describe('private target services', () => {
  it('runs add, login, list, setup, and remove through production service wiring', async () => {
    const h = targetHarness();
    const root = createTempDirectory('zeroshot-runtime-config-');
    const runtimeConfig = path.join(root, 'runtime.json');
    fs.writeFileSync(runtimeConfig, JSON.stringify(RUNTIME_CONFIG));
    try {
      await captureLogs(() => h.services.targetAdd('next', { url: 'https://target.example' }));
      await captureLogs(() => h.services.targetLogin('prod'));
      await captureLogs(() =>
        h.services.targetSetup('prod', {
          repository: 'owner/repository',
          baseRevision: BASE_REVISION,
          runtimeConfig,
        })
      );
      const listed = await captureLogs(() => h.services.targetList({ json: true }));
      assert.match(listed.lines[0], /"configured": true/);
      const persistedSetup = h.state._targets.prod.hostedSetup;
      assert.equal(persistedSetup.runtimeConfigPath, runtimeConfig);
      assert.equal('runtime' in persistedSetup, false);
      assert.equal(JSON.stringify(persistedSetup).includes(RUNTIME_CONFIG.provider), false);
      await captureLogs(() => h.services.targetRemove('prod', { force: false }));

      assert.deepEqual(h.state._targets.prod, undefined);
      assert.equal(h.state._targets.next.id, 'target-next');
      assert.equal(h.calls.filter(([name]) => name === 'login').length, 1);
      assert.equal(h.calls.filter(([name]) => name === 'revoke').length, 1);
      assert.equal(h.calls.filter(([name]) => name === 'delete').length, 1);
    } finally {
      removeTempDirectory(root);
    }
  });
});
