const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  followClaudeTaskLogsIsolated,
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

function createLaunchHarness({ spawnTimeoutMs = 1000, lookupFailures = 0 } = {}) {
  const proc = createProcess();
  const taskId = 'task-durable-race1';
  const commands = [];
  let rowVisible = false;
  let status = 'running';
  let remainingLookupFailures = lookupFailures;
  let capturedEnv;
  const manager = {
    spawnInContainer(_clusterId, _command, options) {
      capturedEnv = options.env;
      return proc;
    },
    execInContainer(_clusterId, command) {
      commands.push(command);
      if (command[1] === 'get-task-id-by-spawn-token') {
        assert.strictEqual(command[2], capturedEnv[OWNERSHIP_ENV]);
        if (remainingLookupFailures > 0) {
          remainingLookupFailures -= 1;
          return { code: 1, stdout: '', stderr: 'lookup unavailable' };
        }
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

  it('retains ambiguous token ownership until a later lookup can terminate the task', async function () {
    const harness = createLaunchHarness({ lookupFailures: 2 });
    const launch = spawnClaudeTaskIsolated(harness.agent, 'test context');
    await waitFor(() => harness.agent.currentTask?.pendingLaunch);
    const pendingHandle = harness.agent.currentTask;
    harness.proc.closed = true;
    harness.proc.emit('close', 0, null);

    const rejection = await launch.then(
      () => null,
      (error) => error
    );
    assert.strictEqual(rejection?.retainTaskHandle, true);
    assert.strictEqual(rejection?.permanent, true);
    assert.strictEqual(harness.agent.currentTask, pendingHandle);

    harness.setRowVisible();
    const termination = await killTask(harness.agent, 'retry ambiguous ownership cleanup');
    assert.strictEqual(termination.taskId, harness.taskId);
    assert.strictEqual(harness.agent.currentTask, null);
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
      execInContainer(_clusterId, command) {
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

  it('retains a terminal follower until persisted cleanup recovery succeeds', async function () {
    const commands = [];
    let cleanupPending = true;
    let cleanupAttempts = 0;
    const manager = {
      spawnInContainer() {
        return createProcess();
      },
      execInContainer(_clusterId, command) {
        commands.push(command);
        const commandText = command.join(' ');
        if (commandText.includes('get-log-path')) {
          return Promise.resolve({ code: 0, stdout: '/tmp/provider.log\n', stderr: '' });
        }
        if (commandText.includes('status')) {
          return Promise.resolve({
            code: 0,
            stdout: `Status: completed\nCleanup: ${cleanupPending ? 'pending' : 'complete'}\n`,
            stderr: '',
          });
        }
        if (command[1] === 'kill') {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) {
            return Promise.resolve({
              code: 1,
              stdout: '',
              stderr: 'cleanup temporarily unavailable',
            });
          }
          cleanupPending = false;
          return Promise.resolve({ code: 0, stdout: 'cleanup recovered\n', stderr: '' });
        }
        if (commandText.includes('cat')) {
          return Promise.resolve({
            code: 0,
            stdout: '{"summary":"done","result":"ok"}\n',
            stderr: '',
          });
        }
        throw new Error(`Unexpected command: ${commandText}`);
      },
    };
    const agent = {
      id: 'terminal-cleanup-follower',
      cluster: { id: 'cluster-1' },
      config: { cwd: '/tmp/work' },
      worktree: null,
      isolation: { enabled: true, clusterId: 'cluster-1', manager },
      currentTask: null,
      currentTaskId: 'terminal-cleanup-task',
      processPid: 123,
      timeout: 0,
      enableLivenessCheck: false,
      messageBus: { publish() {} },
      _resolveProvider: () => 'codex',
      _parseResultOutput: () => ({ summary: 'done', result: 'ok' }),
      _stopLivenessCheck() {},
      _log() {},
    };
    let settled = false;
    const execution = followClaudeTaskLogsIsolated(agent, agent.currentTaskId).finally(() => {
      settled = true;
    });

    while (cleanupAttempts < 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(settled, false);
    assert.notStrictEqual(agent.currentTask, null);

    const result = await execution;
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.parsedResult, { summary: 'done', result: 'ok' });
    assert.strictEqual(cleanupAttempts, 2);
    assert.strictEqual(cleanupPending, false);
    assert.strictEqual(agent.currentTask, null);
    assert.ok(commands.some((command) => command[1] === 'kill'));
  });
});
