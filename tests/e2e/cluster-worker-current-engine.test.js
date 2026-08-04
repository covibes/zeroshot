'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { openClusterWorker } = require('./helpers/cluster-worker-client');
const { buildEnv, cleanupE2ERepo, scenarioPath, setupE2ERepo } = require('./helpers/e2e-harness');

const fixture = path.join(__dirname, 'fixtures', 'current-engine-cluster-worker.js');

function startClient(env, scenario = 'single-worker-success') {
  return openClusterWorker({
    fixture,
    cwd: env.repoDir,
    env: buildEnv(env, {
      FAKE_AGENT_SCENARIO: scenarioPath(scenario),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
    }),
    timeoutMs: 30000,
  });
}

describe('cluster worker current-engine fake-provider e2e', function () {
  this.timeout(60000);

  async function runToResult(providerProfile, scenario) {
    const env = setupE2ERepo();
    const client = startClient(env, scenario);
    try {
      const request = {
        source: 'prompt',
        prompt: 'Implement the bounded task',
        artifacts: [],
        isolationProfile: 'isolation.worktree@1',
        providerProfile,
        repository: 'the-open-engine/zeroshot',
        provider: 'codex',
        modelLevel: 'level2',
      };
      const started = await client.send('start', 'start', { request });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const completed = await client.send('result', 'result');
      assert.strictEqual(completed.ok, true, JSON.stringify(completed));
      return completed.result;
    } finally {
      await client.close();
      cleanupE2ERepo(env);
    }
  }

  it('runs the isolated current engine through the offline fake provider', async () => {
    const result = await runToResult('provider.fake@1', 'single-worker-success');
    assert.strictEqual(result.state, 'completed');
    assert.strictEqual(result.result.status, 'succeeded');
  });

  it('folds durable fake-provider failure and malformed completion', async () => {
    const failed = await runToResult('provider.fake.failure@1', 'single-worker-success');
    assert.strictEqual(failed.state, 'failed');
    assert.deepStrictEqual(failed.outcome, {
      status: 'error',
      code: 'refusal',
      reason: 'policy_denied',
    });
    const malformed = await runToResult('provider.fake.malformed@1', 'single-worker-success');
    assert.strictEqual(malformed.state, 'malformed');
  });

  it('enforces the registry timeout against a delayed offline provider', async () => {
    const result = await runToResult('provider.fake.timeout@1', 'single-worker-success-delayed');
    assert.strictEqual(result.state, 'timed_out');
  });

  it('cancels a delayed offline provider without claiming rollback', async () => {
    const env = setupE2ERepo();
    const client = startClient(env, 'single-worker-success-delayed');
    try {
      const request = {
        source: 'prompt',
        prompt: 'Cancel this bounded task',
        artifacts: [],
        isolationProfile: 'isolation.worktree@1',
        providerProfile: 'provider.fake@1',
        repository: 'the-open-engine/zeroshot',
        provider: 'codex',
        modelLevel: 'level2',
      };
      assert.strictEqual((await client.send('start', 'start', { request })).ok, true);
      const stopped = await client.send('stop', 'stop');
      assert.strictEqual(stopped.result.state, 'stopped');
      assert.strictEqual(stopped.result.stop.externalEffectsRolledBack, false);
    } finally {
      await client.close();
      cleanupE2ERepo(env);
    }
  });
});
