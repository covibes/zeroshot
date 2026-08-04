'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { sanitizeRemoteOperation } = require('../../private/hosted-cli-candidate/default-services');
const { createTargetServices } = require('../../private/hosted-cli-candidate/target-services');

function removalHarness(deleteFailure) {
  const deleted = [];
  let removed = false;
  const target = {
    id: 'target-uuid',
    url: 'https://offline.example',
    hostedSetup: {
      repository: 'owner/repository',
      provider: 'codex',
      modelLevel: 'level2',
    },
  };
  const credentialStore = {
    delete(service, account) {
      deleted.push([service, account]);
      if (deleteFailure === service) throw new Error('keyring unavailable');
    },
  };
  const runtime = {
    target: {
      TARGET_ACCOUNT: 'refresh-token',
      targetServiceKey: (id) => `zeroshot-target-${id}`,
      KeyringCredentialStore: {
        create() {
          return credentialStore;
        },
      },
      discoverTarget() {
        throw new Error('target offline');
      },
      removeTarget() {
        removed = true;
      },
    },
  };
  const services = createTargetServices({
    runtime,
    settings: {},
    httpTransport: () => ({}),
    requireTarget: () => target,
  });
  return { deleted, removed: () => removed, services };
}

it('force removal clears only the login keyring when discovery is offline', async () => {
  const harness = removalHarness();
  await harness.services.targetRemove('prod', { force: true });
  assert.deepEqual(harness.deleted, [['zeroshot-target-target-uuid', 'refresh-token']]);
  assert.equal(harness.removed(), true);
});

it('force removal preserves target metadata when login keyring deletion fails', async () => {
  const harness = removalHarness('zeroshot-target-target-uuid');
  await assert.rejects(
    harness.services.targetRemove('prod', { force: true }),
    /settings were preserved for an exact retry/
  );
  assert.deepEqual(harness.deleted, [['zeroshot-target-target-uuid', 'refresh-token']]);
  assert.equal(harness.removed(), false);
});

it('remote operation boundary never exposes peer-controlled error detail or cause', async () => {
  const canary = 'github-canary-from-peer-884';
  await assert.rejects(
    sanitizeRemoteOperation('status', () => {
      throw new Error(canary);
    }),
    (error) => {
      assert.equal(error.message.includes(canary), false);
      assert.equal(error.cause, undefined);
      assert.equal(error.message, 'Remote status failed; peer-controlled detail was suppressed.');
      return true;
    }
  );
});
