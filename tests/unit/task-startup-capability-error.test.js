const assert = require('node:assert');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sinon = require('sinon');

const {
  assertRequestedWebSearchCliAvailable,
} = require('../../cli/index');
const { executeTask } = require('../../src/agent/agent-lifecycle');
const {
  createUnsupportedProviderCapabilityError,
  parseTaskStartupError,
  serializeTaskStartupError,
} = require('../../src/task-startup-error');

function capabilityError() {
  return createUnsupportedProviderCapabilityError(
    'codex',
    'webSearch',
    'Codex web search was requested, but the codex CLI is not installed.'
  );
}

function createAgent(startupError) {
  const lifecycleEvents = [];
  const published = [];
  let spawnCalls = 0;
  const agent = {
    id: 'capability-worker',
    role: 'implementation',
    cluster: { id: 'capability-cluster' },
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
    _resolveProvider: () => 'codex',
    _log() {},
    _publishLifecycle(event, data) {
      lifecycleEvents.push({ event, data });
    },
    _publish(message) {
      published.push(message);
    },
    _spawnClaudeTask() {
      spawnCalls += 1;
      return Promise.reject(startupError);
    },
  };
  return { agent, lifecycleEvents, published, getSpawnCalls: () => spawnCalls };
}

describe('Task startup capability errors', function () {
  let originalSettingsFile;
  let settingsDir;

  beforeEach(function () {
    originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-capability-startup-'));
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
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('classifies a missing CLI only when declared web search is enabled', function () {
    assert.throws(
      () =>
        assertRequestedWebSearchCliAvailable(
          'codex',
          { providerSettings: { codex: { webSearch: true } } },
          () => false
        ),
      (error) =>
        error.code === 'unsupported-capability' &&
        error.permanent === true &&
        error.provider === 'codex' &&
        error.capability === 'webSearch' &&
        /codex CLI is not installed/.test(error.message)
    );

    let availabilityChecks = 0;
    assert.doesNotThrow(() =>
      assertRequestedWebSearchCliAvailable(
        'codex',
        { providerSettings: { codex: { webSearch: false } } },
        () => {
          availabilityChecks += 1;
          return false;
        }
      )
    );
    assert.strictEqual(availabilityChecks, 0);
  });

  it('restores permanent capability faults from the host task-start wrapper', async function () {
    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    const spawnStub = sinon.stub(childProcess, 'spawn').returns(fakeChild);
    const original = capabilityError();

    try {
      const runnerPath = require.resolve('../../src/claude-task-runner');
      delete require.cache[runnerPath];
      const ClaudeTaskRunner = require(runnerPath);
      const runner = new ClaudeTaskRunner({ quiet: true });
      const pending = runner._spawnAndGetTaskId(
        'zeroshot',
        ['task', 'run'],
        '/tmp',
        {},
        'agent-1'
      );
      fakeChild.stderr.emit('data', Buffer.from(`${serializeTaskStartupError(original)}\n`));
      fakeChild.emit('close', 1);
      const rejection = await pending.then(
        () => null,
        (error) => error
      );

      assert.strictEqual(rejection.code, 'unsupported-capability');
      assert.strictEqual(rejection.permanent, true);
      assert.strictEqual(rejection.message, original.message);
      assert.strictEqual(rejection.provider, original.provider);
      assert.strictEqual(rejection.capability, original.capability);
    } finally {
      spawnStub.restore();
      const runnerPath = require.resolve('../../src/claude-task-runner');
      delete require.cache[runnerPath];
    }
  });

  it('restores permanent capability faults from the isolated TaskRunner', async function () {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    const runnerPath = require.resolve('../../src/claude-task-runner');
    delete require.cache[runnerPath];
    const runner = new ClaudeTaskRunner({ quiet: true, timeout: 1 });
    const original = capabilityError();
    const pending = runner._runIsolated('task context', {
      provider: 'codex',
      isolation: {
        clusterId: 'cluster-1',
        manager: {
          spawnInContainer() {
            return proc;
          },
        },
      },
    });
    proc.stderr.emit('data', Buffer.from(`${'noise'.repeat(120)}\n`));
    proc.stderr.emit('data', Buffer.from(`${serializeTaskStartupError(original)}\n`));
    proc.emit('close', 1);
    const rejection = await pending.then(
      () => null,
      (error) => error
    );

    assert.strictEqual(rejection.code, 'unsupported-capability');
    assert.strictEqual(rejection.permanent, true);
    assert.strictEqual(rejection.provider, original.provider);
    assert.strictEqual(rejection.capability, original.capability);
    assert.strictEqual(rejection.message, original.message);
  });

  it('does not retry a restored permanent capability fault', async function () {
    const original = capabilityError();
    const restored = parseTaskStartupError(`${serializeTaskStartupError(original)}\n`);
    assert(restored);
    const { agent, lifecycleEvents, published, getSpawnCalls } = createAgent(restored);
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};

    try {
      await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'system' });
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    assert.strictEqual(getSpawnCalls(), 1);
    assert.strictEqual(
      lifecycleEvents.filter(({ event }) => event === 'RETRY_SCHEDULED').length,
      0
    );
    const taskFailed = lifecycleEvents.find(({ event }) => event === 'TASK_FAILED');
    assert.deepStrictEqual(taskFailed.data, {
      iteration: 1,
      taskId: null,
      error: original.message,
      code: 'unsupported-capability',
      permanent: true,
      provider: 'codex',
      capability: 'webSearch',
      attempt: 1,
    });
    const clusterFailed = published.find(({ topic }) => topic === 'CLUSTER_FAILED');
    assert(clusterFailed);
    assert.deepStrictEqual(clusterFailed.content.data, {
      reason: 'unsupported_capability',
      agentId: agent.id,
      role: agent.role,
      code: 'unsupported-capability',
      permanent: true,
      provider: 'codex',
      capability: 'webSearch',
      error: original.message,
    });
    const agentError = published.find(({ topic }) => topic === 'AGENT_ERROR');
    assert.strictEqual(agentError.content.data.code, 'unsupported-capability');
    assert.strictEqual(agentError.content.data.permanent, true);
    assert.strictEqual(agent.cluster.failureInfo.code, 'unsupported-capability');
    assert.strictEqual(agent.cluster.failureInfo.permanent, true);
    assert.strictEqual(agent.cluster.failureInfo.provider, 'codex');
    assert.strictEqual(agent.cluster.failureInfo.capability, 'webSearch');
    assert.strictEqual(agent.state, 'error');
  });
});
