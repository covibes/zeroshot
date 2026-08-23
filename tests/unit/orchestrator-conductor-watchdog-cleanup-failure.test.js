const assert = require('node:assert');

const sinon = require('sinon');

const {
  publishConductorCompletion,
  watchdogFailures,
} = require('../helpers/conductor-watchdog-harness');
const {
  closeSqliteOrchestrator,
  createClusterHarness,
  createTempDirectory,
  removeTempDirectory,
} = require('../helpers/orchestrator-sqlite-harness');

describe('Orchestrator conductor watchdog cleanup failures', function () {
  let clock;
  let tempDir;
  let harness;

  beforeEach(function () {
    tempDir = createTempDirectory('zeroshot-conductor-watchdog-cleanup-');
    clock = sinon.useFakeTimers({ now: 1_000 });
    sinon.stub(console, 'error');
  });

  afterEach(function () {
    if (harness) {
      closeSqliteOrchestrator(harness);
    }
    clock.restore();
    sinon.restore();
    removeTempDirectory(tempDir);
    harness = null;
  });

  for (const action of ['stop', 'kill']) {
    it(`restores the pending timer when local ${action} cleanup fails`, async function () {
      const clusterId = `failed-local-${action}`;
      harness = createClusterHarness(tempDir, clusterId);
      const { orchestrator, messageBus, cluster } = harness;
      sinon.stub(orchestrator, '_saveClusters').resolves();
      sinon.stub(orchestrator, '_signalRemoteCluster').resolves();
      cluster.agents.push({ stop: sinon.stub().rejects(new Error(`${action} cleanup failed`)) });
      orchestrator._registerConductorWatchdog(messageBus, clusterId);
      publishConductorCompletion(messageBus, clusterId);
      clock.tick(5_000);

      await assert.rejects(orchestrator[action](clusterId), {
        message: `${action} cleanup failed`,
      });

      assert.strictEqual(orchestrator._conductorWatchdogs.size, 1);
      clock.tick(24_999);
      assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 0);
      clock.tick(1);
      assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 1);
    });
  }
});
