const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sinon = require('sinon');

const Ledger = require('../../src/ledger');
const MessageBus = require('../../src/message-bus');
const Orchestrator = require('../../src/orchestrator');

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

describe('Orchestrator critical agent error handling', function () {
  this.timeout(10_000);

  let tempDir;
  let ledger;
  let messageBus;
  let orchestrator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-orchestrator-agent-error-'));
    ledger = new Ledger(path.join(tempDir, 'test.db'));
    messageBus = new MessageBus(ledger);

    orchestrator = new Orchestrator({ quiet: true, skipLoad: true, storageDir: tempDir });
    sinon.stub(orchestrator, '_saveClusters').resolves();
  });

  afterEach(() => {
    sinon.restore();
    if (ledger) ledger.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops cluster when coordinator fails after retries', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c1');

    publishAgentError(messageBus, 'c1', 'consensus-coordinator', {
      role: 'coordinator',
      attempts: 3,
      error: 'boom',
    });

    await new Promise((r) => setTimeout(r, 10));
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

    await new Promise((r) => setTimeout(r, 10));
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

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopSpy.called, false);
  });

  it('does not terminalize a retryable critical-agent status observation', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerAgentErrorHandler(messageBus, 'c4');

    publishAgentError(messageBus, 'c4', 'worker', {
      role: 'implementation',
      attempts: 1,
      error: 'polling_timeout',
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopSpy.called, false);
    assert.equal(messageBus.query({ cluster_id: 'c4', topic: 'CLUSTER_FAILED' }).length, 0);
  });

  it('does not stop twice after a durable cluster failure', async () => {
    const stopSpy = sinon.stub(orchestrator, 'stop').resolves();
    orchestrator._registerClusterCompletionHandlers(messageBus, 'c5');
    orchestrator._registerAgentErrorHandler(messageBus, 'c5');
    publishClusterFailure(messageBus, 'c5');
    publishAgentError(messageBus, 'c5', 'worker', {
      role: 'implementation',
      attempts: 3,
      error: 'retry budget exhausted',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopSpy.callCount, 1);
  });
});
