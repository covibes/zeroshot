const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('node:url');

const { startLivenessCheck, stopLivenessCheck, stop } = require('../src/agent/agent-lifecycle');
const { killTask, spawnTaskProcess } = require('../src/agent/agent-task-executor');
const Orchestrator = require('../src/orchestrator');
const MockTaskRunner = require('./helpers/mock-task-runner');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

function createLivenessAgent(overrides = {}) {
  const events = [];
  const kills = [];
  const agent = {
    id: 'worker',
    role: 'implementation',
    currentTask: { kill() {} },
    currentTaskId: 'provider-task',
    processPid: null,
    lastOutputTime: Date.now(),
    taskStartedAt: Date.now(),
    staleDuration: 30,
    timeout: 0,
    livenessCheckInterval: null,
    _log() {},
    _publishLifecycle(event, data) {
      events.push({ event, data });
    },
    _killTask(reason) {
      kills.push(reason);
      this.currentTask = null;
    },
    ...overrides,
  };
  return { agent, events, kills };
}

function workerConfig() {
  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        modelLevel: 'level2',
        outputFormat: 'text',
        maxRetries: 1,
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: { topic: 'CLUSTER_COMPLETE' },
          },
        },
      },
    ],
  };
}

function createPendingLaunchAgent() {
  return {
    currentTask: null,
    currentTaskId: null,
    processPid: null,
    lastOutputTime: null,
    taskStartedAt: null,
    _publishLifecycle() {},
    _stopLivenessCheck() {},
    _log() {},
  };
}

async function createPendingLaunchFixture() {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-launch-windows-'));
  const fakeZeroshot = path.join(fakeBin, 'zeroshot');
  const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
  const retryKillMarker = path.join(fakeBin, 'retry-kill-marker');
  fs.writeFileSync(
    fakeZeroshot,
    `#!/usr/bin/env node
    (async () => {
      const fs = require('node:fs');
      const { addTask, updateTask } = await import(${JSON.stringify(storeUrl)});
      const action = process.argv[2];
      const taskId = process.argv[3];
      if (
        action === 'kill' &&
        taskId === 'launch-retry-task' &&
        !fs.existsSync(${JSON.stringify(retryKillMarker)})
      ) {
        fs.writeFileSync(${JSON.stringify(retryKillMarker)}, 'failed once\\n');
        process.exitCode = 1;
        return;
      }
      if (action === 'kill') {
        updateTask(taskId, {
          status: 'killed',
          pid: null,
          processGroupId: null,
          cancelRequested: false,
          commandCleanup: null
        });
        return;
      }
      if (action === 'pre-row') {
        setInterval(() => {}, 1000);
        return;
      }
      if (action === 'timeout-row') {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      addTask({
        id: taskId,
        status: 'running',
        pid: null,
        spawnOwnershipToken: process.env.ZEROSHOT_TASK_SPAWN_OWNERSHIP_TOKEN,
        commandCleanup: null
      });
      if (action === 'post-row' || action === 'timeout-row') {
        setInterval(() => {}, 1000);
        return;
      }
      process.stdout.write('Task spawned: ' + taskId + '\\n');
    })().catch((error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    `,
    { mode: 0o755 }
  );
  const { getTask, removeTask } = await import(storeUrl);
  return { fakeBin, fakeZeroshot, getTask, removeTask };
}

describe('Agent stuck-task recovery', function () {
  this.timeout(10000);
  let settingsDir;
  let originalSettingsFile;

  beforeEach(function () {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-stuck-recovery-'));
    originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    process.env.ZEROSHOT_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({
        staleWarningsBeforeKill: 2,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
        jitterFactor: 0,
      })
    );
  });

  it('retries shutdown termination while an unconfirmed task handle remains', async function () {
    let terminationAttempts = 0;
    const agent = {
      id: 'shutdown-retry',
      running: true,
      state: 'running',
      currentTask: {},
      livenessCheckInterval: null,
      unsubscribe: null,
      _currentExecution: null,
      _log() {},
      _killTask() {
        terminationAttempts += 1;
        if (terminationAttempts === 1) {
          return { forced: false, reason: 'provider still running' };
        }
        this.currentTask = null;
        return { forced: true };
      },
    };

    await assert.rejects(stop(agent), /could not confirm termination/);
    assert.strictEqual(agent.running, false);
    assert.notStrictEqual(agent.currentTask, null);

    await stop(agent);
    assert.strictEqual(terminationAttempts, 2);
    assert.strictEqual(agent.currentTask, null);
  });

  afterEach(function () {
    if (originalSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    }
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('terminates a live task after bounded cross-platform stale warnings', async function () {
    const { agent, events, kills } = createLivenessAgent();
    startLivenessCheck(agent);
    await waitFor(() => kills.length === 1);
    stopLivenessCheck(agent);

    assert.strictEqual(events.filter(({ event }) => event === 'AGENT_STALE_WARNING').length, 2);
    assert.strictEqual(kills[0].code, 'PROVIDER_INACTIVITY_TIMEOUT');
    assert.ok(events.some(({ event }) => event === 'AGENT_INACTIVITY_TIMEOUT'));
  });

  it('resets stale warnings when output progress resumes', async function () {
    const { agent, events, kills } = createLivenessAgent({ staleDuration: 80 });
    startLivenessCheck(agent);
    await waitFor(() => events.filter(({ event }) => event === 'AGENT_STALE_WARNING').length === 1);
    agent.lastOutputTime = Date.now();
    await sleep(60);
    stopLivenessCheck(agent);

    assert.strictEqual(kills.length, 0);
    assert.strictEqual(agent.consecutiveStaleWarnings, 0);
  });

  it('enforces an absolute task timeout while output remains recent', async function () {
    const { agent, events, kills } = createLivenessAgent({
      staleDuration: 1000,
      timeout: 30,
      taskStartedAt: Date.now() - 100,
    });
    startLivenessCheck(agent);
    await waitFor(() => kills.length === 1);
    stopLivenessCheck(agent);

    assert.strictEqual(kills[0].code, 'AGENT_TASK_TIMEOUT');
    assert.ok(events.some(({ event }) => event === 'AGENT_TASK_TIMEOUT'));
  });

  it('reconciles transient state and preserves the termination reason', async function () {
    const reasons = [];
    const agent = {
      currentTask: { kill: (reason) => reasons.push(reason) },
      currentTaskId: null,
      processPid: 4242,
      lastOutputTime: Date.now(),
      taskStartedAt: Date.now(),
      _stopLivenessCheck() {},
    };
    await killTask(agent, 'Provider inactivity timeout');

    assert.deepStrictEqual(reasons, ['Provider inactivity timeout']);
    for (const field of [
      'currentTask',
      'currentTaskId',
      'processPid',
      'lastOutputTime',
      'taskStartedAt',
    ]) {
      assert.strictEqual(agent[field], null);
    }
  });

  it('retains the caller task handle until durable termination and cleanup are confirmed', async function () {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-kill-pending-'));
    const fakeZeroshot = path.join(fakeBin, 'zeroshot');
    fs.writeFileSync(fakeZeroshot, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    let followerKilled = false;
    let livenessStopped = false;
    const agent = {
      currentTask: {
        kill() {
          followerKilled = true;
        },
      },
      currentTaskId: 'startup-cancel-pending',
      taskCommandPath: fakeZeroshot,
      processPid: null,
      lastOutputTime: 123,
      taskStartedAt: 456,
      _stopLivenessCheck() {
        livenessStopped = true;
      },
      _log() {},
    };

    try {
      const result = await killTask(agent, 'Provider inactivity timeout');
      assert.strictEqual(result.forced, false);
      assert.strictEqual(agent.currentTaskId, 'startup-cancel-pending');
      assert.notStrictEqual(agent.currentTask, null);
      assert.strictEqual(followerKilled, false);
      assert.strictEqual(livenessStopped, false);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });


  it('cancels pending launches before persistence, before wrapper close, and before follower install', async function () {
    const { fakeBin, fakeZeroshot, getTask, removeTask } =
      await createPendingLaunchFixture();
    const taskIds = ['launch-prerow-task', 'launch-postrow-task', 'launch-postid-task'];

    try {
      for (const state of ['pre-row', 'post-row', 'post-id']) {
        const taskId = `launch-${state.replace('-', '')}-task`;
        removeTask(taskId);
        const agent = createPendingLaunchAgent();
        const launch = spawnTaskProcess({
          agent,
          ctPath: fakeZeroshot,
          args: [state, taskId],
          cwd: process.cwd(),
          spawnEnv: process.env,
        });
        const launchRejection =
          state === 'post-id' ? null : assert.rejects(launch, /killed by signal/i);
        await waitFor(() => agent.currentTask?.pendingLaunch);
        if (state === 'post-row') await waitFor(() => getTask(taskId), 10000);
        if (state === 'post-id') await launch;

        const termination = await killTask(agent, `cancel ${state}`);
        assert.notStrictEqual(termination?.forced, false, state);
        assert.strictEqual(agent.currentTask, null, state);
        assert.strictEqual(agent.currentTaskId, null, state);
        if (state !== 'pre-row') {
          assert.strictEqual(getTask(taskId)?.status, 'killed', state);
        }
        if (launchRejection) await launchRejection;
      }
    } finally {
      for (const taskId of taskIds) removeTask(taskId);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('retries an unconfirmed pending-launch cancellation', async function () {
    const { fakeBin, fakeZeroshot, getTask, removeTask } =
      await createPendingLaunchFixture();
    const taskId = 'launch-retry-task';
    removeTask(taskId);
    const agent = createPendingLaunchAgent();

    try {
      const launch = spawnTaskProcess({
        agent,
        ctPath: fakeZeroshot,
        args: ['post-row', taskId],
        cwd: process.cwd(),
        spawnEnv: process.env,
      });
      const rejection = assert.rejects(launch, /killed by signal/i);
      await waitFor(() => getTask(taskId), 10000);

      const firstTermination = await killTask(agent, 'first cancellation attempt');
      assert.strictEqual(firstTermination?.forced, false);
      assert.notStrictEqual(agent.currentTask, null);

      const secondTermination = await killTask(agent, 'second cancellation attempt');
      assert.notStrictEqual(secondTermination?.forced, false);
      assert.strictEqual(agent.currentTask, null);
      assert.strictEqual(getTask(taskId)?.status, 'killed');
      await rejection;
    } finally {
      removeTask(taskId);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('terminates a durable child after a pending-launch timeout', async function () {
    const { fakeBin, fakeZeroshot, getTask, removeTask } =
      await createPendingLaunchFixture();
    const taskId = 'launch-timeout-task';
    removeTask(taskId);
    const agent = createPendingLaunchAgent();

    try {
      let timeoutError;
      try {
        await spawnTaskProcess({
          agent,
          ctPath: fakeZeroshot,
          args: ['timeout-row', taskId],
          cwd: process.cwd(),
          spawnEnv: process.env,
          spawnTimeoutMs: 300,
        });
      } catch (error) {
        timeoutError = error;
      }

      assert.match(timeoutError?.message || '', /Spawn timeout/);
      assert.strictEqual(timeoutError.commandCleanupOwner, 'task-lifecycle');
      assert.strictEqual(getTask(taskId)?.status, 'killed');
      assert.strictEqual(agent.currentTask, null);
      assert.strictEqual(agent.currentTaskId, null);
    } finally {
      removeTask(taskId);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
  async function runMockRecovery({ failures, maxRestartAttempts, maxTotalRestarts }) {
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({
        maxRestartAttempts,
        maxTotalRestarts,
        staleWarningsBeforeKill: 2,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
        jitterFactor: 0,
      })
    );
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-restart-ledger-'));
    const runner = new MockTaskRunner();
    const orchestrator = new Orchestrator({
      storageDir,
      taskRunner: runner,
      skipLoad: true,
      quiet: true,
    });
    let calls = 0;
    runner.when('worker').calls(() => {
      calls += 1;
      return calls <= failures
        ? {
            success: false,
            output: '{"type":"turn.started"}\n',
            error: 'Provider produced no output',
            code: 'PROVIDER_INACTIVITY_TIMEOUT',
          }
        : { success: true, output: 'done' };
    });
    const started = await orchestrator.start(workerConfig(), { text: 'recover the task' });
    await waitFor(() => orchestrator.getStatus(started.id).state === 'stopped');
    return { orchestrator, storageDir, runner, started };
  }

  it('records durable restart attempts and completes after bounded retries', async function () {
    const fixture = await runMockRecovery({
      failures: 2,
      maxRestartAttempts: 2,
      maxTotalRestarts: 5,
    });
    try {
      const cluster = fixture.orchestrator.getCluster(fixture.started.id);
      const events = cluster.messageBus
        .query({
          cluster_id: fixture.started.id,
          topic: 'AGENT_LIFECYCLE',
          sender: 'worker',
        })
        .map((message) => message.content.data.event);
      assert.strictEqual(events.filter((event) => event === 'AGENT_RESTART_ATTEMPT').length, 2);
      assert.strictEqual(events.filter((event) => event === 'TASK_COMPLETED').length, 1);
    } finally {
      fixture.orchestrator.close();
      await sleep(100);
      fs.rmSync(fixture.storageDir, { recursive: true, force: true });
    }
  });

  it('exhausts restart budgets and persists a stopped clean state', async function () {
    const fixture = await runMockRecovery({
      failures: 4,
      maxRestartAttempts: 2,
      maxTotalRestarts: 2,
    });
    try {
      assert.strictEqual(fixture.runner.getCalls('worker').length, 3);
      assert.strictEqual(fixture.orchestrator.getStatus(fixture.started.id).state, 'stopped');
      let saved;
      await waitFor(() => {
        const registry = JSON.parse(
          fs.readFileSync(path.join(fixture.storageDir, 'clusters.json'), 'utf8')
        );
        saved = registry[fixture.started.id];
        return saved?.state === 'stopped';
      });
      assert.strictEqual(saved.state, 'stopped');
      assert.deepStrictEqual(
        [saved.agentStates[0].currentTask, saved.agentStates[0].currentTaskId],
        [false, null]
      );
      assert.strictEqual(saved.failureInfo.attempts, 3);
    } finally {
      fixture.orchestrator.close();
      await sleep(100);
      fs.rmSync(fixture.storageDir, { recursive: true, force: true });
    }
  });
});
