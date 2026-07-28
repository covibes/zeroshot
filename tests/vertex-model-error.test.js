const assert = require('assert');

const { executeTask } = require('../src/agent/agent-lifecycle');

function createAgent(errorMessage) {
  const lifecycleEvents = [];
  const published = [];
  let spawnCalls = 0;
  const agent = {
    id: 'vertex-worker',
    role: 'implementation',
    cluster: { id: 'vertex-cluster' },
    config: { hooks: {}, maxRetries: 3 },
    iteration: 0,
    maxIterations: 10,
    running: true,
    state: 'idle',
    testMode: true,
    quiet: true,
    currentTaskId: null,
    messageBus: { publish() {} },
    _buildContext: () => 'task context',
    _selectModel: () => 'sonnet',
    _resolveModelSpec: () => null,
    _resolveProvider: () => 'claude',
    _log() {},
    _publishLifecycle(event, data) {
      lifecycleEvents.push({ event, data });
    },
    _publish(message) {
      published.push(message);
    },
    async _spawnClaudeTask() {
      spawnCalls += 1;
      this.currentTaskId = `vertex-task-${spawnCalls}`;
      return { success: false, error: errorMessage, taskId: this.currentTaskId };
    },
  };

  return { agent, lifecycleEvents, published, getSpawnCalls: () => spawnCalls };
}

describe('Vertex model failure handling', function () {
  it('logs the enabled-model command and stops after one deterministic failure', async function () {
    const errorMessage = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: 404,
      result:
        'API Error: model (claude-sonnet-4-5@20250929) is not available in this vertex deployment',
    });
    const { agent, lifecycleEvents, published, getSpawnCalls } = createAgent(errorMessage);
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'system' });
    } finally {
      console.error = originalConsoleError;
    }

    const log = errors.join('\n');
    assert.strictEqual(getSpawnCalls(), 1, 'deterministic model failure must not be retried');
    assert.match(
      log,
      /"claude-sonnet-4-5@20250929" is not available on your Vertex AI deployment/
    );
    assert.match(
      log,
      /zeroshot settings set providerSettings\.claude\.levelOverrides/
    );
    assert.strictEqual(
      lifecycleEvents.some(({ event }) => event === 'RETRY_SCHEDULED'),
      false
    );
    const agentError = published.find(({ topic }) => topic === 'AGENT_ERROR');
    assert(agentError, 'final AGENT_ERROR must be published');
    assert.strictEqual(agentError.content.data.attempts, 1);
  });
});
