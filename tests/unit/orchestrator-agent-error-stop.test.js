const assert = require('node:assert');

const sinon = require('sinon');

const {
  closeSqliteOrchestrator,
  createSqliteOrchestrator,
  createTempDirectory,
  removeTempDirectory,
} = require('../helpers/orchestrator-sqlite-harness');

function publishAgentError(messageBus, clusterId, sender, data) {
  messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_ERROR',
    sender,
    content: { data },
  });
}

function publishClusterFailure(messageBus, clusterId) {
  messageBus.publish({
    cluster_id: clusterId,
    topic: 'CLUSTER_FAILED',
    sender: 'worker',
    content: { data: { reason: 'provider_execution_failed' } },
  });
}

function settleHandlers() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

let tempDir;
let messageBus;
let orchestrator;
let harness;

function setupHarness() {
  tempDir = createTempDirectory('zeroshot-orchestrator-agent-error-');
  harness = createSqliteOrchestrator(tempDir, 'test.db');
  ({ messageBus, orchestrator } = harness);
  sinon.stub(orchestrator, '_saveClusters').resolves();
}

function cleanupHarness() {
  sinon.restore();
  if (harness) {
    closeSqliteOrchestrator(harness);
  }
  if (tempDir) {
    removeTempDirectory(tempDir);
  }
}

describe('Orchestrator critical agent error handling', function () {
  this.timeout(10_000);

  beforeEach(setupHarness);
  afterEach(cleanupHarness);

  it('stops cluster when coordinator fails after retries', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c1');

    publishAgentError(messageBus, 'c1', 'consensus-coordinator', {
      role: 'coordinator',
      attempts: 3,
      retryBudgetExhausted: true,
      error: 'boom',
    });

    await settleHandlers();
    assert.equal(stopSpy.calledOnce, true);
    assert.equal(stopSpy.firstCall.args[0], 'c1');
  });

  it('stops cluster immediately when hookFailure is true (even with attempts=1)', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c2');

    publishAgentError(messageBus, 'c2', 'consensus-coordinator', {
      role: 'coordinator',
      attempts: 1,
      hookFailure: true,
      error: 'hook died',
    });

    await settleHandlers();
    assert.equal(stopSpy.calledOnce, true);
    assert.equal(stopSpy.firstCall.args[0], 'c2');
  });

  it('does not stop cluster for validator errors by default', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c3');

    publishAgentError(messageBus, 'c3', 'validator-1', {
      role: 'validator',
      attempts: 3,
      error: 'nope',
    });
    await settleHandlers();
    assert.equal(stopSpy.called, false);
  });

  it('does not terminalize a retryable critical-agent status observation', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c4');

    publishAgentError(messageBus, 'c4', 'worker', {
      role: 'implementation',
      attempts: 30,
      error: 'polling_timeout',
    });

    await settleHandlers();
    assert.equal(stopSpy.called, false);
    assert.equal(messageBus.query({ cluster_id: 'c4', topic: 'CLUSTER_FAILED' }).length, 0);
  });
});

describe('Orchestrator workflow role terminalization', function () {
  beforeEach(setupHarness);
  afterEach(cleanupHarness);

  it('stops cluster when planner, conductor, and orchestrator roles exhaust retries', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    for (const [clusterId, sender, role] of [
      ['planning-cluster', 'planner', 'planning'],
      ['conductor-cluster', 'junior-conductor', 'conductor'],
      ['orchestrator-cluster', 'completion-detector', 'orchestrator'],
    ]) {
      orchestrator._registerAgentErrorHandler(messageBus, clusterId);
      publishAgentError(messageBus, clusterId, sender, {
        role,
        attempts: 3,
        retryBudgetExhausted: true,
        error: 'retry budget exhausted',
      });
    }

    await settleHandlers();
    assert.deepStrictEqual(stopSpy.args.map(([clusterId]) => clusterId).sort(), [
      'conductor-cluster',
      'orchestrator-cluster',
      'planning-cluster',
    ]);
  });
});

describe('Orchestrator terminal stop deduplication', function () {
  beforeEach(setupHarness);
  afterEach(cleanupHarness);

  it('deduplicates only a current-run durable cluster failure', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerClusterCompletionHandlers(messageBus, 'c5');
    orchestrator._registerAgentErrorHandler(messageBus, 'c5');
    publishClusterFailure(messageBus, 'c5');
    publishAgentError(messageBus, 'c5', 'worker', {
      role: 'implementation',
      attempts: 3,
      retryBudgetExhausted: true,
      error: 'retry budget exhausted',
    });

    await settleHandlers();
    assert.equal(stopSpy.callCount, 1);

    stopSpy.resetHistory();
    publishClusterFailure(messageBus, 'c6');
    orchestrator._registerAgentErrorHandler(messageBus, 'c6');
    publishAgentError(messageBus, 'c6', 'worker', {
      role: 'implementation',
      attempts: 3,
      retryBudgetExhausted: true,
      error: 'failed again after resume',
    });

    await settleHandlers();
    assert.equal(stopSpy.callCount, 1);
    assert.equal(stopSpy.firstCall.args[0], 'c6');
  });
});
