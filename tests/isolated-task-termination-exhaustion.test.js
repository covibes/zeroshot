const assert = require('assert');
const { stop } = require('../src/agent/agent-lifecycle');

const {
  runLifecycleRecovery,
  runPermanentWatchdogFailure,
  sleep,
  useZeroBackoffSettings,
} = require('./helpers/isolated-task-recovery-fixture');

describe('Bounded isolated task recovery', function () {
  this.timeout(7000);
  useZeroBackoffSettings();

  const permanentFailures = [
    ['kill command failure', { killCommandFailures: Infinity }],
    ['status verification failure', { unverifiableKillAttempts: Infinity }],
  ];

  for (const [label, managerOptions] of permanentFailures) {
    it(`fails closed after bounded ${label} attempts`, async function () {
      const recovered = await runPermanentWatchdogFailure(managerOptions);

      assert.strictEqual(recovered.outcome.timedOut, undefined);
      assert.strictEqual(recovered.outcome.error?.code, 'ISOLATED_TASK_TERMINATION_EXHAUSTED');
      assert.strictEqual(recovered.outcome.error?.permanent, true);
      assert.strictEqual(recovered.killCalls, 3);
      assert.strictEqual(recovered.manager.maxConcurrentKillCalls, 1);
      assert.strictEqual(recovered.stillMonitored, false);
      assert.notStrictEqual(recovered.agent.currentTask, null);
      assert.strictEqual(recovered.agent.currentTaskId, 'isolated-task');
      assert.strictEqual(recovered.agent.state, 'error');
      assert.strictEqual(recovered.agent.cluster.failureInfo.type, 'task_termination');
      assert.strictEqual(recovered.agent.cluster.failureInfo.reason, 'termination_unverified');
      assert.strictEqual(recovered.agent.cluster.failureInfo.attempts, 3);
      assert.strictEqual(
        recovered.events.filter(({ event }) => event === 'AGENT_INACTIVITY_TIMEOUT').length,
        1
      );
      assert.strictEqual(
        recovered.events.filter(({ event }) => event === 'AGENT_TERMINATION_RETRY').length,
        2
      );
      assert.strictEqual(
        recovered.events.filter(({ event }) => event === 'AGENT_TERMINATION_EXHAUSTED').length,
        1
      );

      await sleep(50);
      assert.strictEqual(recovered.manager.killCalls, 3);
      recovered.manager.allowTermination();
      recovered.agent.running = true;
      await stop(recovered.agent);
      assert.strictEqual(recovered.manager.killCalls, 4);
      assert.strictEqual(recovered.agent.currentTask, null);
    });

    it(`does not retry the provider after permanent ${label}`, async function () {
      const recovered = await runLifecycleRecovery(managerOptions);
      const agentErrors = recovered.published.filter(({ topic }) => topic === 'AGENT_ERROR');
      const clusterFailures = recovered.published.filter(({ topic }) => topic === 'CLUSTER_FAILED');

      assert.strictEqual(recovered.spawnCalls, 1);
      assert.strictEqual(recovered.manager.killCalls, 3);
      assert.strictEqual(recovered.manager.maxConcurrentKillCalls, 1);
      assert.strictEqual(recovered.agent.state, 'error');
      assert.strictEqual(recovered.agent.currentTaskId, 'isolated-task-1');
      assert.strictEqual(recovered.agent.cluster.failureInfo.type, 'task_termination');
      assert.strictEqual(recovered.agent.cluster.failureInfo.reason, 'termination_unverified');
      assert.strictEqual(recovered.agent.cluster.failureInfo.attempts, 3);
      assert.strictEqual(agentErrors.length, 1);
      assert.strictEqual(agentErrors[0].content.data.terminationExhausted, true);
      assert.strictEqual(agentErrors[0].content.data.restartExhausted, true);
      assert.strictEqual(agentErrors[0].content.data.attempts, 3);
      assert.strictEqual(clusterFailures.length, 1);
      assert.strictEqual(clusterFailures[0].content.data.reason, 'task_termination_unverified');
      assert.notStrictEqual(recovered.agent.currentTask, null);
      recovered.manager.allowTermination();
      await stop(recovered.agent);
      assert.strictEqual(recovered.manager.killCalls, 4);
      assert.strictEqual(recovered.agent.currentTask, null);
    });
  }
});
