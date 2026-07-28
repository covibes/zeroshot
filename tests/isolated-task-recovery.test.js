const assert = require('assert');

const { startLivenessCheck, stopLivenessCheck } = require('../src/agent/agent-lifecycle');
const { followClaudeTaskLogsIsolated } = require('../src/agent/agent-task-executor');
const {
  createIsolatedAgent,
  createIsolationManager,
  runLifecycleRecovery,
  runWatchdogRecovery,
  useZeroBackoffSettings,
  waitFor,
} = require('./helpers/isolated-task-recovery-fixture');

function countLifecycleEvents(events, expectedEvent) {
  return events.filter(({ event }) => event === expectedEvent).length;
}

describe('Isolated task recovery', function () {
  this.timeout(7000);
  useZeroBackoffSettings();

  it('terminates a stale task inside its container exactly once', async function () {
    const recovered = await runWatchdogRecovery({
      lastOutputTime: Date.now() - 100,
      taskStartedAt: Date.now() - 100,
    });

    assert.strictEqual(recovered.manager.killCalls, 1);
    assert.strictEqual(recovered.result.success, false);
    assert.strictEqual(recovered.result.code, 'PROVIDER_INACTIVITY_TIMEOUT');
    assert.strictEqual(recovered.agent.currentTask, null);
    assert.strictEqual(recovered.agent.currentTaskId, null);
    assert.ok(
      recovered.events.some(({ event }) => event === 'AGENT_INACTIVITY_TIMEOUT'),
      'durable inactivity recovery event should be emitted'
    );
  });

  it('terminates an absolute-timeout task inside its container exactly once', async function () {
    const recovered = await runWatchdogRecovery({
      timeout: 30,
      staleDuration: 1000,
      lastOutputTime: Date.now(),
      taskStartedAt: Date.now() - 100,
    });

    assert.strictEqual(recovered.manager.killCalls, 1);
    assert.strictEqual(recovered.result.success, false);
    assert.strictEqual(recovered.result.code, 'AGENT_TASK_TIMEOUT');
    assert.strictEqual(recovered.agent.currentTask, null);
    assert.strictEqual(recovered.agent.currentTaskId, null);
    assert.ok(
      recovered.events.some(({ event }) => event === 'AGENT_TASK_TIMEOUT'),
      'durable absolute-timeout recovery event should be emitted'
    );
  });

  it('re-arms lifecycle recovery after an in-container kill command fails', async function () {
    const recovered = await runWatchdogRecovery(
      {
        lastOutputTime: Date.now() - 100,
        taskStartedAt: Date.now() - 100,
      },
      { killCommandFailures: 1 }
    );

    assert.strictEqual(recovered.manager.killCalls, 2);
    assert.strictEqual(recovered.manager.maxConcurrentKillCalls, 1);
    assert.strictEqual(recovered.result.success, false);
    assert.strictEqual(recovered.agent.currentTask, null);
    assert.strictEqual(recovered.agent.currentTaskId, null);
  });

  it('re-arms lifecycle recovery when kill status cannot be verified', async function () {
    const recovered = await runWatchdogRecovery(
      {
        lastOutputTime: Date.now() - 100,
        taskStartedAt: Date.now() - 100,
      },
      { unverifiableKillAttempts: 1 }
    );

    assert.strictEqual(recovered.manager.killCalls, 2);
    assert.strictEqual(recovered.manager.maxConcurrentKillCalls, 1);
    assert.strictEqual(recovered.result.success, false);
    assert.strictEqual(recovered.agent.currentTask, null);
    assert.strictEqual(recovered.agent.currentTaskId, null);
  });
});

describe('Isolated task lifecycle handles', function () {
  this.timeout(7000);
  useZeroBackoffSettings();

  it('does not ignore a tracked isolated task while its local handle is briefly absent', async function () {
    const manager = createIsolationManager();
    const { agent, events } = createIsolatedAgent(manager, {
      currentTask: null,
      lastOutputTime: Date.now() - 100,
      taskStartedAt: Date.now() - 100,
    });
    let termination = null;
    agent._killTask = (reason) => {
      termination = reason;
      agent.currentTaskId = null;
    };

    startLivenessCheck(agent);
    await waitFor(() => termination);
    stopLivenessCheck(agent);

    assert.strictEqual(termination.code, 'PROVIDER_INACTIVITY_TIMEOUT');
    assert.ok(events.some(({ event }) => event === 'AGENT_INACTIVITY_TIMEOUT'));
  });

  it('preserves completion while terminal cleanup recovery wins reconciliation', async function () {
    const manager = createIsolationManager({ status: 'completed' });
    const { agent } = createIsolatedAgent(manager, {
      lastOutputTime: Date.now() - 100,
      taskStartedAt: Date.now() - 100,
    });
    const execution = followClaudeTaskLogsIsolated(agent, agent.currentTaskId);

    await waitFor(() => agent.currentTask);
    startLivenessCheck(agent);
    const result = await execution;
    stopLivenessCheck(agent);

    assert.strictEqual(result.success, true);
    assert.strictEqual(manager.killCalls, 1);
    assert.strictEqual(agent.currentTask, null);
  });

  it('clears the lifecycle handle on normal isolated completion without recovery', async function () {
    const manager = createIsolationManager({ status: 'completed' });
    const { agent } = createIsolatedAgent(manager);
    const result = await followClaudeTaskLogsIsolated(agent, agent.currentTaskId);

    assert.strictEqual(result.success, true);
    assert.strictEqual(manager.killCalls, 0);
    assert.strictEqual(agent.currentTask, null);
  });

  it('clears the lifecycle handle when isolated log setup fails', async function () {
    const manager = createIsolationManager();
    manager.execInContainer = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'log lookup failed' });
    const { agent } = createIsolatedAgent(manager);

    await assert.rejects(
      followClaudeTaskLogsIsolated(agent, agent.currentTaskId),
      /log lookup failed/
    );
    assert.strictEqual(agent.currentTask, null);
  });
});

describe('Isolated task termination reconciliation', function () {
  this.timeout(7000);
  useZeroBackoffSettings();

  it('preserves a natural completion that wins the in-container kill race', async function () {
    const recovered = await runWatchdogRecovery(
      {
        lastOutputTime: Date.now() - 100,
        taskStartedAt: Date.now() - 100,
      },
      { terminalStatusOnKill: 'completed' }
    );

    assert.deepStrictEqual(
      {
        killCalls: recovered.manager.killCalls,
        success: recovered.result.success,
        code: recovered.result.code,
        timeoutEvents: countLifecycleEvents(recovered.events, 'AGENT_INACTIVITY_TIMEOUT'),
      },
      { killCalls: 1, success: true, code: undefined, timeoutEvents: 0 }
    );
  });

  it('does not start a replacement provider after natural completion wins the kill race', async function () {
    const recovered = await runLifecycleRecovery({ terminalStatusOnKill: 'completed' });

    assert.deepStrictEqual(
      {
        spawnCalls: recovered.spawnCalls,
        killCalls: recovered.manager.killCalls,
        timeoutEvents: countLifecycleEvents(recovered.events, 'AGENT_INACTIVITY_TIMEOUT'),
        completions: countLifecycleEvents(recovered.events, 'TASK_COMPLETED'),
        restarts: countLifecycleEvents(recovered.events, 'AGENT_RESTART_ATTEMPT'),
      },
      { spawnCalls: 1, killCalls: 1, timeoutEvents: 0, completions: 1, restarts: 0 }
    );
  });

  for (const terminalStatus of ['failed', 'cancelled']) {
    it(`preserves natural ${terminalStatus} semantics when it wins the kill race`, async function () {
      const recovered = await runWatchdogRecovery(
        {
          lastOutputTime: Date.now() - 100,
          taskStartedAt: Date.now() - 100,
        },
        { terminalStatusOnKill: terminalStatus }
      );

      assert.strictEqual(recovered.manager.killCalls, 1);
      assert.strictEqual(recovered.result.success, false);
      assert.strictEqual(recovered.result.code, undefined);
      assert.doesNotMatch(recovered.result.error, /produced no output for \d+ms/);
      assert.strictEqual(countLifecycleEvents(recovered.events, 'AGENT_INACTIVITY_TIMEOUT'), 0);
    });
  }
});
