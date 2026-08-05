'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { sanitizeRemoteOperation } = require('../../private/hosted-cli-candidate/default-services');
const { createTargetServices } = require('../../private/hosted-cli-candidate/target-services');
const { captureLogs } = require('./candidate-fixtures');
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

it('queued transport never serializes process credentials or reusable authority', async () => {
  const secrets = {
    GH_TOKEN: 'gh-queue-secret-canary-884',
    OPENAI_API_KEY: 'openai-queue-secret-canary-884',
    ZEROSHOT_TARGET_ACCESS_TOKEN: 'target-queue-secret-canary-884',
  };
  const previous = Object.fromEntries(
    Object.keys(secrets).map((name) => [name, process.env[name]])
  );
  let submitted;
  Object.assign(process.env, secrets);
  try {
    const h = remoteHarness({
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
    await captureLogs(() =>
      h.services.remoteQueueRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        queue: true,
        submissionKey: SUBMISSION_KEY,
        detach: true,
      })
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const serialized = JSON.stringify(submitted);
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(serialized.includes(name), false);
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(Object.keys(submitted.envelope), ['version', 'graph', 'input']);
  assert.deepEqual(submitted.envelope.input, {
    source: 'prompt',
    prompt: 'Ship the change.',
    artifacts: [],
  });
  for (const authority of ['owner/repository', 'codex', 'level2']) {
    assert.equal(serialized.includes(authority), false);
  }
  assert.equal(
    /credentials|token|environment|endpoint|settings|command|path|runtime|repository|provider|modelLevel/i.test(
      serialized
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
