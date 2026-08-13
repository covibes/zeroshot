const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Orchestrator = require('../src/orchestrator');
const MockTaskRunner = require('./helpers/mock-task-runner');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_CONFIG_PATH = path.join(REPO_ROOT, 'cluster-templates', 'topology-generator.json');
const VALID_DESIGN_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'topology-generator',
  'e2e-design.json'
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function waitForTopic(cluster, topic, count = 1, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = cluster.messageBus.query({ cluster_id: cluster.id, topic });
    if (messages.length >= count) return messages;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} ${topic} message(s)`);
}

async function waitForState(cluster, state, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (cluster.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for cluster state ${state}; current state is ${cluster.state}`
  );
}

describe('Topology admission repair', function () {
  this.timeout(20000);

  let orchestrator;
  let storageDir;

  afterEach(async () => {
    if (orchestrator) {
      for (const cluster of orchestrator.listClusters()) {
        if (cluster.state === 'stopped') continue;
        try {
          await orchestrator.kill(cluster.id);
        } catch {
          // Best-effort cleanup of the isolated test cluster.
        }
      }
      orchestrator.close();
      orchestrator = null;
    }
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
      storageDir = null;
    }
  });

  it('rejects one generated topology, lets the designer repair it, and completes', async () => {
    const seedConfig = readJson(SEED_CONFIG_PATH);
    const validDesign = readJson(VALID_DESIGN_PATH);
    delete validDesign.__comment;

    const invalidDesign = JSON.parse(JSON.stringify(validDesign));
    invalidDesign.reasoning = 'First proposal deliberately contains a forbidden validator action.';
    invalidDesign.agents.find((agent) => agent.role === 'validator').systemPrompt =
      'Run git diff and use its output as the validation oracle.';

    const taskRunner = new MockTaskRunner();
    let designerCall = 0;
    taskRunner.when('topology-designer').calls(async () => {
      designerCall += 1;
      if (designerCall === 2) {
        // Make the old fatal catch reliably race ahead of the repair turn.
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return {
        success: true,
        output: JSON.stringify(designerCall === 1 ? invalidDesign : validDesign),
        error: null,
      };
    });
    taskRunner.when('doc-writer').returns({
      completed: true,
      userDeliverable: 'A finished introduction.',
    });
    taskRunner.when('verifier-structure').returns({
      approved: true,
      disposition: 'approved',
      summary: 'Structure passes',
      errors: [],
      evidence: [{ check: 'intro', method: 'direct read', output: 'finished', passed: true }],
    });
    taskRunner.when('verifier-source-fidelity').returns({
      approved: true,
      disposition: 'approved',
      summary: 'Fidelity passes',
      errors: [],
      evidence: [{ check: 'task', method: 'direct read', output: 'matches', passed: true }],
    });

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-topology-repair-'));
    orchestrator = new Orchestrator({ quiet: true, storageDir, taskRunner });

    const started = await orchestrator.start(seedConfig, {
      text: "Make an intro for a children's book",
    });
    const cluster = orchestrator.getCluster(started.id);

    await waitForTopic(cluster, 'VALIDATION_RESULT');

    taskRunner.assertCalled('topology-designer', 2);
    taskRunner.assertCalledWith(
      'topology-designer',
      (call) =>
        call.callNumber === 2 &&
        call.context.includes("instructs use of 'git diff'") &&
        call.context.includes('explicit prohibitions')
    );
    taskRunner.assertCalled('doc-writer', 1);
    assert.strictEqual(
      cluster.messageBus.query({
        cluster_id: cluster.id,
        topic: 'CLUSTER_OPERATIONS_VALIDATION_FAILED',
      }).length,
      1,
      'the rejected proposal should produce one repair event'
    );
    assert.strictEqual(
      cluster.messageBus.query({ cluster_id: cluster.id, topic: 'CLUSTER_OPERATIONS_FAILED' })
        .length,
      0,
      'a repairable admission rejection must not also become a fatal operation failure'
    );
    assert.strictEqual(
      cluster.messageBus.query({ cluster_id: cluster.id, topic: 'CLUSTER_OPERATIONS_SUCCESS' })
        .length,
      1,
      'the repaired proposal should be admitted and executed'
    );
    await waitForState(cluster, 'stopped');
  });

  it('bounds admission repair to the promised three retries', async () => {
    const seedConfig = readJson(SEED_CONFIG_PATH);
    const invalidDesign = readJson(VALID_DESIGN_PATH);
    delete invalidDesign.__comment;
    invalidDesign.agents.find((agent) => agent.role === 'validator').systemPrompt =
      'Run git diff and use its output as the validation oracle.';

    assert.strictEqual(
      seedConfig.agents.find((agent) => agent.id === 'topology-designer').maxIterations,
      4,
      'the seed must allow one initial design plus exactly three repair attempts'
    );

    const taskRunner = new MockTaskRunner();
    taskRunner.when('topology-designer').returns(invalidDesign);

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-topology-repair-limit-'));
    orchestrator = new Orchestrator({ quiet: true, storageDir, taskRunner });

    const started = await orchestrator.start(seedConfig, { text: 'Test the repair bound' });
    const cluster = orchestrator.getCluster(started.id);
    const failures = await waitForTopic(cluster, 'CLUSTER_FAILED');

    taskRunner.assertCalled('topology-designer', 4);
    assert.strictEqual(
      cluster.messageBus.query({
        cluster_id: cluster.id,
        topic: 'CLUSTER_OPERATIONS_VALIDATION_FAILED',
      }).length,
      4,
      'each rejected design should publish actionable repair feedback'
    );
    assert.strictEqual(failures[0].content.data.reason, 'max_iterations');
    assert.strictEqual(failures[0].content.data.maxIterations, 4);
    await waitForState(cluster, 'stopped');
  });
});
