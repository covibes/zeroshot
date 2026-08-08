'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { sanitizeRemoteOperation } = require('../../private/hosted-cli-candidate/default-services');
const { createTargetServices } = require('../../private/hosted-cli-candidate/target-services');
const { captureLogs, detachedQueueOptions } = require('./candidate-fixtures');
const { assertSecretsAbsent, withEnvironment } = require('./environment-harness');
const { remoteHarness } = require('./remote-service-harness');

const INTENT_ID = '019fd184-bcb4-73dd-a631-d43c64297869';
const SUBMISSION_KEY = '019fd184-cb95-47ed-93cf-3cf51b07a528';
const NOW = '2026-08-05T10:00:00.000Z';

function removalHarness(deleteFailure) {
  const deleted = [];
  let removed = false;
  const target = {
    id: 'target-uuid',
    url: 'https://offline.example',
    hostedSetup: {
      repository: 'owner/repository',
      runtime: { provider: 'custom-runtime' },
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
      discoverTargetSessionEndpoints() {
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

it('queued transport keeps runtime credentials outside the unchanged v2 envelope', async () => {
  const secrets = {
    GH_TOKEN: 'gh-queue-secret-canary-884',
    OPENAI_API_KEY: 'openai-queue-secret-canary-884',
    ZEROSHOT_TARGET_ACCESS_TOKEN: 'target-queue-secret-canary-884',
  };
  let submitted;
  await withEnvironment(secrets, async () => {
    const h = remoteHarness({
      environment: {
        GH_TOKEN: secrets.GH_TOKEN,
        LOCAL_MODEL_KEY: secrets.OPENAI_API_KEY,
      },
      createRunIntentClient: () => ({
        submit(request) {
          submitted = request;
          return {
            intent_id: INTENT_ID,
            state: 'queued',
            waiting_reason: null,
            capsule_id: null,
            result: null,
            error_code: null,
            submitted_at: NOW,
            updated_at: NOW,
            terminal_at: null,
          };
        },
      }),
    });
    await captureLogs(() => h.services.remoteQueueRun(detachedQueueOptions(SUBMISSION_KEY)));
  });
  const serialized = JSON.stringify(submitted);
  assertSecretsAbsent(JSON.stringify(submitted.envelope), secrets);
  assert.deepEqual(Object.keys(submitted.envelope), ['version', 'graph', 'input']);
  assert.deepEqual(submitted.envelope.input, {
    source: 'prompt',
    prompt: 'Ship the change.',
    artifacts: [],
  });
  assert.equal(submitted.runtime.githubToken, secrets.GH_TOKEN);
  assert.equal(submitted.runtime.runtime.environment.ANTHROPIC_API_KEY, secrets.OPENAI_API_KEY);
  assert.equal(serialized.includes(secrets.ZEROSHOT_TARGET_ACCESS_TOKEN), false);
  assert.equal(
    /credentials|token|environment|endpoint|settings|command|path|runtime|repository|provider|modelLevel/i.test(
      JSON.stringify(submitted.envelope)
    ),
    false
  );
});

it('rejects forbidden queued input before the RunIntent client can submit', async () => {
  let submissions = 0;
  const h = remoteHarness({
    hostedInput: {
      source: 'prompt',
      prompt: 'Ship the change.',
      artifacts: [],
      command: 'cat /etc/secrets',
    },
    createRunIntentClient: () => ({
      submit() {
        submissions += 1;
      },
    }),
  });
  await assert.rejects(
    h.services.remoteQueueRun({
      target: 'prod',
      graph: 'graph.json',
      input: 'input.json',
      queue: true,
      submissionKey: SUBMISSION_KEY,
      detach: true,
    })
  );
  assert.equal(submissions, 0);
});
