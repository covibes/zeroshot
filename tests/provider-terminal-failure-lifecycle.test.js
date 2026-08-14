const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { isolatedAgent, isolatedTailManager } = require('./helpers/isolated-provider-lifecycle');
const { ompSdkErrorFrame } = require('./helpers/omp-sdk-protocol');

const { executeTask } = require('../src/agent/agent-lifecycle');
const { isCriticalAgent } = require('../src/agent/critical-agent-policy');
const { followClaudeTaskLogsIsolated } = require('../src/agent/agent-task-executor');
const { extractProviderFailure } = require('../src/agent/provider-terminal-failure');

const SAFE_RETRYABLE_ERROR = 'Provider codex failed (unknown; unknown-retryable)';

function retryableFailureAgent(messages, lifecycle) {
  return {
    id: 'worker',
    role: 'implementation',
    running: true,
    state: 'idle',
    iteration: 0,
    maxIterations: 5,
    currentTaskId: null,
    currentGuidanceSequence: null,
    config: { maxRetries: 1, hooks: {}, cwd: process.cwd() },
    cluster: { id: 'retryable-max-one', failureInfo: null },
    messageBus: { query: () => [], publish: (message) => messages.push(message) },
    _buildContext: () => 'synthetic context',
    _spawnClaudeTask: () =>
      Promise.resolve({
        success: false,
        error: SAFE_RETRYABLE_ERROR,
        providerFailure: {
          error: SAFE_RETRYABLE_ERROR,
          provider: 'codex',
          event: 'turn.failed',
          category: 'unknown',
          classification: { retryable: true, kind: 'unknown-retryable' },
          diagnostic: { byteLength: 7, sha256: '0'.repeat(64) },
        },
      }),
    _publish: (message) => messages.push(message),
    _publishLifecycle: (event, data) => lifecycle.push({ event, data }),
    _selectModel: () => 'synthetic',
    _resolveProvider: () => 'codex',
    _log() {},
  };
}

describe('provider terminal failure lifecycle', function () {
  this.timeout(10_000);

  it('terminalizes a retryable provider failure when maxRetries is one', async function () {
    const messages = [];
    const lifecycle = [];
    const agent = retryableFailureAgent(messages, lifecycle);

    await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'user' });

    const clusterFailures = messages.filter((message) => message.topic === 'CLUSTER_FAILED');
    const agentErrors = messages.filter((message) => message.topic === 'AGENT_ERROR');
    assert.strictEqual(clusterFailures.length, 1);
    assert.strictEqual(agentErrors.length, 1);
    assert.strictEqual(clusterFailures[0].content.data.attempts, 1);
    assert.strictEqual(clusterFailures[0].content.data.retryable, true);
    assert.strictEqual(agentErrors[0].content.data.attempts, 1);
    assert.strictEqual(agentErrors[0].content.data.retryable, true);
    assert.deepStrictEqual(
      lifecycle.map((entry) => entry.event),
      ['TASK_STARTED', 'TASK_FAILED']
    );
    assert.strictEqual(agent.cluster.failureInfo.attempts, 1);
  });

  it('installs failure info before a specific terminal event is published', async function () {
    const messages = [];
    const lifecycle = [];
    const agent = retryableFailureAgent(messages, lifecycle);
    let failureInfoAtPublish = null;
    agent._spawnClaudeTask = () => {
      const error = new Error('onComplete hook failed');
      error.hookFailure = true;
      error.hookRetries = 1;
      return Promise.reject(error);
    };
    agent._publish = (message) => {
      if (message.topic === 'CLUSTER_FAILED' && failureInfoAtPublish === null) {
        failureInfoAtPublish = { ...agent.cluster.failureInfo };
      }
      messages.push(message);
    };

    await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'user' });

    assert.strictEqual(failureInfoAtPublish.error, 'onComplete hook failed');
    assert.strictEqual(failureInfoAtPublish.attempts, 1);
    assert.strictEqual(failureInfoAtPublish.agentId, 'worker');
  });

  it('preserves the closed OMP SDK authentication classification', function () {
    const frame = JSON.stringify(ompSdkErrorFrame());

    const failure = extractProviderFailure(frame, 'omp');
    assert.strictEqual(failure.error, 'Provider omp failed (authentication; permanent-pattern)');
    assert.strictEqual(failure.category, 'authentication');
    assert.deepStrictEqual(failure.classification, {
      retryable: false,
      kind: 'permanent-pattern',
    });
  });
});

describe('critical workflow role terminalization', function () {
  it('uses one terminal policy for executable workflow roles', function () {
    for (const role of [
      'planning',
      'implementation',
      'conductor',
      'coordinator',
      'completion',
      'orchestrator',
    ]) {
      assert.strictEqual(isCriticalAgent({ id: role, role }), true);
    }
    assert.strictEqual(isCriticalAgent({ id: 'consensus-coordinator', role: 'custom' }), true);
    assert.strictEqual(isCriticalAgent({ id: 'validator-1', role: 'validator' }), false);
    assert.strictEqual(isCriticalAgent({ id: 'missing-role' }), false);
  });

  it('terminalizes retryable provider failure for planner, conductor, and orchestrator roles', async function () {
    for (const [id, role] of [
      ['planner', 'planning'],
      ['junior-conductor', 'conductor'],
      ['completion-detector', 'orchestrator'],
    ]) {
      const messages = [];
      const lifecycle = [];
      const agent = retryableFailureAgent(messages, lifecycle);
      agent.id = id;
      agent.role = role;

      await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'user' });

      const clusterFailures = messages.filter((message) => message.topic === 'CLUSTER_FAILED');
      const agentErrors = messages.filter((message) => message.topic === 'AGENT_ERROR');
      assert.strictEqual(clusterFailures.length, 1);
      assert.strictEqual(clusterFailures[0].content.data.reason, 'provider_execution_failed');
      assert.strictEqual(clusterFailures[0].content.data.role, role);
      assert.strictEqual(agentErrors.length, 1);
    }
  });

  it('keeps validator provider exhaustion nonterminal', async function () {
    const messages = [];
    const lifecycle = [];
    const agent = retryableFailureAgent(messages, lifecycle);
    agent.id = 'validator-requirements';
    agent.role = 'validator';
    agent.testMode = true;

    await executeTask(agent, { topic: 'IMPLEMENTATION_READY', sender: 'worker' });

    assert.strictEqual(messages.filter((message) => message.topic === 'CLUSTER_FAILED').length, 0);
    assert.strictEqual(messages.filter((message) => message.topic === 'AGENT_ERROR').length, 1);
  });
});

describe('isolated provider terminal failure lifecycle', function () {
  this.timeout(10_000);

  it('redacts an isolated failure observed only during terminal catch-up', async function () {
    const rawError = 'insufficient_quota: Authorization: Bearer isolated-final-secret';
    const raw = `${JSON.stringify({
      type: 'turn.failed',
      error: { message: rawError },
    })}\n`;
    const published = [];
    const manager = isolatedTailManager(raw, 'failed');
    const agent = isolatedAgent('codex', manager, published);

    const result = await followClaudeTaskLogsIsolated(agent, 'task-final-only', {
      skipStructuredResultCheck: true,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Provider codex failed (quota; permanent-pattern)');
    assert.deepStrictEqual(result.providerFailure.diagnostic, {
      byteLength: Buffer.byteLength(rawError),
      sha256: createHash('sha256').update(rawError).digest('hex'),
    });
    assert.strictEqual(published.length, 1);
    const serialized = JSON.stringify(published);
    assert.doesNotMatch(
      serialized,
      /isolated-final-secret|Authorization: Bearer|insufficient_quota/
    );
  });
});
