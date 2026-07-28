const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  killTask,
  spawnClaudeTaskIsolated,
} = require('../src/agent/agent-task-executor');

const OWNERSHIP_ENV = 'ZEROSHOT_TASK_SPAWN_OWNERSHIP_TOKEN';

function createProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 12345;
  proc.closed = false;
  proc.kill = (signal) => {
    if (proc.closed) return;
    proc.closed = true;
    setImmediate(() => proc.emit('close', null, signal));
  };
  return proc;
}

function createLaunchHarness({ spawnTimeoutMs = 1000 } = {}) {
  const proc = createProcess();
  const taskId = 'task-durable-race1';
  const commands = [];
  let rowVisible = false;
  let status = 'running';
  let capturedEnv;
  const manager = {
    spawnInContainer(_clusterId, _command, options) {
      capturedEnv = options.env;
      return proc;
    },
    async execInContainer(_clusterId, command) {
      commands.push(command);
      if (command[1] === 'get-task-id-by-spawn-token') {
        assert.strictEqual(command[2], capturedEnv[OWNERSHIP_ENV]);
        return rowVisible
          ? { code: 0, stdout: `${taskId}\n`, stderr: '' }
          : { code: 2, stdout: '', stderr: '' };
      }
      if (command[1] === 'status') {
        return { code: 0, stdout: `Status: ${status}\n`, stderr: '' };
      }
      if (command[1] === 'kill') {
        status = 'killed';
        return { code: 0, stdout: `Killed ${taskId}\n`, stderr: '' };
      }
      throw new Error(`Unexpected command: ${command.join(' ')}`);
    },
  };
  const agent = {
    id: 'isolated-race',
    config: { outputFormat: 'json', strictSchema: true },
    isolation: { enabled: true, clusterId: 'cluster-1', manager },
    enableLivenessCheck: false,
    spawnTimeoutMs,
    _resolveProvider: () => 'opencode',
    _resolveModelSpec: () => ({
      level: 'level2',
      model: 'openai/gpt-5.2-codex',
      reasoningEffort: 'high',
    }),
    _resolveModelSpecSource: () => 'direct',
    _log() {},
    _publishLifecycle() {},
    _stopLivenessCheck() {},
  };
  return {
    agent,
    commands,
    proc,
    taskId,
    setRowVisible() {
      rowVisible = true;
    },
    get capturedEnv() {
      return capturedEnv;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

async function expectCancelledLaunch(harness) {
  const launch = spawnClaudeTaskIsolated(harness.agent, 'test context');
  await waitFor(() => harness.agent.currentTask?.pendingLaunch);
  const termination = await killTask(harness.agent, 'cancel launch');
  assert.notStrictEqual(termination?.forced, false);
  await assert.rejects(launch, /Task launch cancelled/);
  assert.strictEqual(harness.agent.currentTask, null);
  return termination;
}

describe('Isolated detached launch ownership', function () {
  it('cancels before task-row persistence without inventing task ownership', async function () {
    const harness = createLaunchHarness();
    const termination = await expectCancelledLaunch(harness);

    assert.strictEqual(termination.taskId, null);
    assert.strictEqual(harness.commands.some((command) => command[1] === 'kill'), false);
    assert.ok(harness.capturedEnv[OWNERSHIP_ENV]);
  });

  it('resolves the durable token and kills a post-row task before wrapper close', async function () {
    const harness = createLaunchHarness();
    const launch = spawnClaudeTaskIsolated(harness.agent, 'test context');
    await waitFor(() => harness.agent.currentTask?.pendingLaunch);
    harness.setRowVisible();

    const termination = await killTask(harness.agent, 'cancel post-row');
    assert.strictEqual(termination.taskId, harness.taskId);
    await assert.rejects(launch, /Task launch cancelled/);
    assert.ok(harness.commands.some((command) => command[1] === 'kill'));
  });

  it('uses the durable token when stdout has a task ID but the wrapper is still open', async function () {
    const harness = createLaunchHarness();
    const launch = spawnClaudeTaskIsolated(harness.agent, 'test context');
    await waitFor(() => harness.agent.currentTask?.pendingLaunch);
    harness.setRowVisible();
    harness.proc.stdout.write(`Task spawned: ${harness.taskId}\n`);

    const termination = await killTask(harness.agent, 'cancel post-id');
    assert.strictEqual(termination.taskId, harness.taskId);
    await assert.rejects(launch, /Task launch cancelled/);
    assert.ok(harness.commands.some((command) => command[1] === 'kill'));
  });

  it('cancels after durable ID assignment but before follower installation', async function () {
    const harness = createLaunchHarness();
    let terminationPromise = null;
    harness.agent._publishLifecycle = (event) => {
      if (event === 'TASK_ID_ASSIGNED' && !terminationPromise) {
        terminationPromise = killTask(harness.agent, 'cancel post-ID assignment');
      }
    };
    const launch = spawnClaudeTaskIsolated(harness.agent, 'test context');
    const launchRejection = assert.rejects(launch, /Task launch cancelled/);
    await waitFor(() => harness.agent.currentTask?.pendingLaunch);
    harness.setRowVisible();
    harness.proc.stdout.write(`Task spawned: ${harness.taskId}\n`);
    harness.proc.closed = true;
    harness.proc.emit('close', 0, null);

    await waitFor(() => terminationPromise);
    const termination = await terminationPromise;
    assert.strictEqual(termination.taskId, harness.taskId);
    await launchRejection;
    assert.ok(harness.commands.some((command) => command[1] === 'kill'));
  });

  it('routes spawn timeout through durable child termination', async function () {
    const harness = createLaunchHarness({ spawnTimeoutMs: 30 });
    harness.setRowVisible();

    await assert.rejects(
      spawnClaudeTaskIsolated(harness.agent, 'test context'),
      /Spawn timeout after 0.03s/
    );
    assert.ok(harness.commands.some((command) => command[1] === 'kill'));
    assert.strictEqual(harness.agent.currentTask, null);
  });
});

describe('Isolated terminal cleanup recovery', function () {
  function createTerminalAgent({ failCleanup = false } = {}) {
    const commands = [];
    let shouldFail = failCleanup;
    const manager = {
      async execInContainer(_clusterId, command) {
        commands.push(command);
        if (command[1] === 'status') {
          return { code: 0, stdout: 'Status: killed\n', stderr: '' };
        }
        if (command[1] === 'kill') {
          if (shouldFail) {
            return { code: 1, stdout: '', stderr: 'command cleanup remains pending' };
          }
          return { code: 0, stdout: 'cleanup recovered\n', stderr: '' };
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      },
    };
    const handle = { retained: true };
    const agent = {
      currentTask: handle,
      currentTaskId: 'task-terminal-cleanup',
      processPid: 123,
      lastOutputTime: 1,
      taskStartedAt: 1,
      isolation: { enabled: true, clusterId: 'cluster-1', manager },
      _stopLivenessCheck() {},
    };
    return {
      agent,
      commands,
      handle,
      allowCleanup() {
        shouldFail = false;
      },
    };
  }

  it('invokes kill to recover cleanup for a task already terminal before the call', async function () {
    const harness = createTerminalAgent();
    const result = await killTask(harness.agent, 'terminal cleanup');

    assert.strictEqual(result.alreadyTerminal, true);
    assert.ok(harness.commands.some((command) => command[1] === 'kill'));
    assert.strictEqual(harness.agent.currentTask, null);
    assert.strictEqual(harness.agent.currentTaskId, null);
  });

  it('retains the lifecycle handle on cleanup failure and clears it after retry', async function () {
    const harness = createTerminalAgent({ failCleanup: true });
    const failed = await killTask(harness.agent, 'terminal cleanup');

    assert.strictEqual(failed.forced, false);
    assert.match(failed.reason, /command cleanup remains pending/);
    assert.strictEqual(harness.agent.currentTask, harness.handle);
    assert.strictEqual(harness.agent.currentTaskId, 'task-terminal-cleanup');

    harness.allowCleanup();
    const recovered = await killTask(harness.agent, 'terminal cleanup retry');
    assert.strictEqual(recovered.alreadyTerminal, true);
    assert.strictEqual(harness.agent.currentTask, null);
    assert.strictEqual(harness.agent.currentTaskId, null);
  });
});
