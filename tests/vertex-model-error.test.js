const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeTask } = require('../src/agent/agent-lifecycle');
const { buildCompletionResult, parseResultOutput } = require('../src/agent/agent-task-executor');

function claudeErrorEnvelope(status, result) {
  return `[1234567890123]${JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    api_error_status: status,
    result,
  })}`;
}

function createAgent(rawOutputs) {
  const lifecycleEvents = [];
  const published = [];
  let spawnCalls = 0;
  const agent = {
    id: 'vertex-worker',
    role: 'implementation',
    cluster: { id: 'vertex-cluster' },
    config: { hooks: {}, maxRetries: 3, outputFormat: 'json' },
    iteration: 0,
    maxIterations: 10,
    running: true,
    state: 'idle',
    testMode: true,
    quiet: true,
    currentTask: null,
    currentTaskId: null,
    processPid: null,
    lastOutputTime: null,
    taskStartedAt: null,
    messageBus: { publish() {} },
    _buildContext: () => 'task context',
    _selectModel: () => 'sonnet',
    _resolveModelSpec: () => null,
    _resolveProvider: () => 'claude',
    _parseResultOutput(output) {
      return parseResultOutput(this, output);
    },
    _log() {},
    _publishLifecycle(event, data) {
      lifecycleEvents.push({ event, data });
    },
    _publish(message) {
      published.push(message);
    },
    async _spawnClaudeTask() {
      const output = rawOutputs[spawnCalls];
      spawnCalls += 1;
      const taskId = `vertex-task-${spawnCalls}`;
      this.currentTask = { id: taskId };
      this.currentTaskId = taskId;
      this.processPid = 1234;
      this.lastOutputTime = Date.now();
      this.taskStartedAt = Date.now();
      const result = await buildCompletionResult({
        agent: this,
        taskId,
        providerName: 'claude',
        state: { output },
        stdout: 'Status: completed',
        success: true,
      });
      result.taskId = taskId;
      return result;
    },
  };

  return { agent, lifecycleEvents, published, getSpawnCalls: () => spawnCalls };
}

describe('Vertex model failure handling', function () {
  let originalSettingsFile;
  let originalUseVertex;
  let settingsDir;

  beforeEach(function () {
    originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    originalUseVertex = process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-vertex-error-'));
    process.env.ZEROSHOT_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({ backoffBaseMs: 0, backoffMaxMs: 0, jitterFactor: 0 })
    );
  });

  afterEach(function () {
    if (originalSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    }
    if (originalUseVertex === undefined) {
      delete process.env.CLAUDE_CODE_USE_VERTEX;
    } else {
      process.env.CLAUDE_CODE_USE_VERTEX = originalUseVertex;
    }
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('carries raw Vertex metadata through parsing and terminalizes the second attempt', async function () {
    const rawOutputs = [
      claudeErrorEnvelope(500, 'API Error: transient backend failure'),
      claudeErrorEnvelope(
        404,
        'API Error: model (claude-sonnet-4-5@20250929) is not available in this vertex deployment'
      ),
    ];
    const { agent, lifecycleEvents, published, getSpawnCalls } = createAgent(rawOutputs);
    const errors = [];
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = (...args) => errors.push(args.join(' '));
    console.warn = () => {};

    try {
      await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'system' });
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    const log = errors.join('\n');
    assert.strictEqual(getSpawnCalls(), 2, 'Vertex failure must stop after the current attempt');
    assert.match(log, /TASK EXECUTION FAILED - AGENT: vertex-worker \(Attempt 2\/3\)/);
    assert.match(log, /"claude-sonnet-4-5@20250929" is not available on your Vertex AI deployment/);
    assert.match(log, /manually edit providerSettings\.claude\.levelOverrides/);
    assert.match(log, /0600/);
    assert.doesNotMatch(log, /zeroshot settings set providerSettings/);

    const failedEvents = lifecycleEvents.filter(({ event }) => event === 'TASK_FAILED');
    assert.deepStrictEqual(
      failedEvents.map(({ data }) => data.attempt),
      [1, 2]
    );
    assert.strictEqual(
      lifecycleEvents.filter(({ event }) => event === 'RETRY_SCHEDULED').length,
      1
    );

    const clusterFailed = published.find(({ topic }) => topic === 'CLUSTER_FAILED');
    assert(clusterFailed, 'terminal Vertex failure must signal the orchestrator');
    assert.strictEqual(clusterFailed.content.data.reason, 'vertex_model_unavailable');
    assert.strictEqual(clusterFailed.content.data.model, 'claude-sonnet-4-5@20250929');

    const agentError = published.find(({ topic }) => topic === 'AGENT_ERROR');
    assert(agentError, 'final AGENT_ERROR must be published');
    assert.strictEqual(agentError.content.data.attempts, 2);
    assert.strictEqual(agent.cluster.failureInfo.attempts, 2);
    assert.strictEqual(agent.cluster.failureInfo.taskId, 'vertex-task-2');
    assert.strictEqual(agent.state, 'idle');
    assert.strictEqual(agent.currentTask, null);
    assert.strictEqual(agent.currentTaskId, null);
    assert.strictEqual(agent.processPid, null);
    assert.strictEqual(agent.lastOutputTime, null);
    assert.strictEqual(agent.taskStartedAt, null);
  });

  it('does not classify matching text from another provider', async function () {
    const { agent } = createAgent([]);
    const result = await buildCompletionResult({
      agent,
      taskId: 'codex-task',
      providerName: 'codex',
      state: {
        output: claudeErrorEnvelope(
          404,
          'API Error: model (other-model) is not available in this vertex deployment'
        ),
      },
      stdout: 'Status: failed',
      success: false,
    });

    assert.strictEqual(result.vertexModelError, null);
  });

  it('requires Vertex configuration and a model for the generic Claude 404 fallback', async function () {
    const { agent } = createAgent([]);
    const buildClaudeFailure = (result) =>
      buildCompletionResult({
        agent,
        taskId: 'claude-task',
        providerName: 'claude',
        state: { output: claudeErrorEnvelope(404, result) },
        stdout: 'Status: failed',
        success: false,
      });

    const genericResource = await buildClaudeFailure(
      'API Error: resource may not exist or you may not have access'
    );
    const unconfiguredModel = await buildClaudeFailure(
      'API Error: model (claude-sonnet-4-5@20250929) may not exist or you may not have access'
    );
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const vertexResource = await buildClaudeFailure(
      'API Error: resource may not exist or you may not have access'
    );
    const vertexModel = await buildClaudeFailure(
      'API Error: model (claude-sonnet-4-5@20250929) may not exist or you may not have access'
    );

    assert.strictEqual(genericResource.vertexModelError, null);
    assert.strictEqual(unconfiguredModel.vertexModelError, null);
    assert.strictEqual(vertexResource.vertexModelError, null);
    assert.deepStrictEqual(vertexModel.vertexModelError, {
      model: 'claude-sonnet-4-5@20250929',
    });
  });
});
