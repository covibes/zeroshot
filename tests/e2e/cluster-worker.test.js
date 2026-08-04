'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openClusterWorker } = require('./helpers/cluster-worker-client');

const fixture = path.join(__dirname, 'fixtures', 'fake-cluster-worker.js');
const artifact = {
  artifactId: 'artifact-1',
  sha256: 'b'.repeat(64),
  byteLength: 5,
  mediaType: 'text/plain',
  typeId: 'openengine.test.text@1',
  producer: { node: 'node.test', worker: 'worker.test@1' },
  lineage: { generation: 0, runId: 'run-1', attempt: 1 },
  redaction: 'internal',
};

function openWorker() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cluster-worker-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cluster-worker-repo-'));
  const client = openClusterWorker({
    fixture,
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
    },
    timeoutMs: 1000,
  });

  async function close() {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  return { ...client, close };
}

function promptRequest(prompt, isolationProfile = 'isolation.worktree@1') {
  return {
    source: 'prompt',
    prompt,
    artifacts: [],
    isolationProfile,
    providerProfile: 'provider.default@1',
    repository: 'the-open-engine/zeroshot',
    provider: 'codex',
    modelLevel: 'level2',
  };
}

describe('cluster worker executable e2e', function () {
  this.timeout(5000);

  for (const [scenario, expectedState] of [
    ['success', 'completed'],
    ['failure', 'failed'],
    ['malformed', 'malformed'],
    ['timeout', 'timed_out'],
  ]) {
    it(`normalizes fake-provider ${scenario} without API access`, async () => {
      const client = openWorker();
      try {
        assert.strictEqual(
          (await client.send('start', 'start', { request: promptRequest(scenario) })).ok,
          true
        );
        const response = await client.send('result', 'result');
        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.result.state, expectedState);
      } finally {
        await client.close();
      }
    });
  }

  it('cancels explicitly without claiming rollback', async () => {
    const client = openWorker();
    try {
      await client.send('start', 'start', { request: promptRequest('timeout') });
      const response = await client.send('stop', 'stop');
      assert.strictEqual(response.result.state, 'stopped');
      assert.strictEqual(response.result.stop.externalEffectsRolledBack, false);
    } finally {
      await client.close();
    }
  });

  it('accepts byte-free artifact input', async () => {
    const client = openWorker();
    try {
      const request = {
        source: 'artifact',
        artifacts: [artifact],
        isolationProfile: 'isolation.worktree@1',
        providerProfile: 'provider.default@1',
        repository: 'the-open-engine/zeroshot',
        provider: 'codex',
        modelLevel: 'level2',
      };
      assert.strictEqual((await client.send('start', 'start', { request })).ok, true);
      assert.strictEqual((await client.send('result', 'result')).result.state, 'completed');
    } finally {
      await client.close();
    }
  });

  it('rejects non-isolated profiles before fake-engine start', async () => {
    const client = openWorker();
    try {
      const response = await client.send('start', 'start', {
        request: promptRequest('success', 'isolation.none@1'),
      });
      assert.strictEqual(response.ok, false);
      assert.match(response.error.message, /non-isolated execution/);
      assert.strictEqual((await client.send('status', 'status')).result.clusterId, null);
    } finally {
      await client.close();
    }
  });
});
