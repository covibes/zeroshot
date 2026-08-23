const assert = require('node:assert');

const sinon = require('sinon');

const Orchestrator = require('../../src/orchestrator');
const {
  deferred,
  publishClusterOperations,
  publishConductorCompletion,
  publishTerminal,
  watchdogFailures,
} = require('../helpers/conductor-watchdog-harness');
const {
  closeSqliteOrchestrator,
  createClusterHarness,
  createTempDirectory,
  removeTempDirectory,
} = require('../helpers/orchestrator-sqlite-harness');

function createHarness(tempDir, harnesses, clusterId) {
  const resources = createClusterHarness(tempDir, clusterId);
  const { orchestrator } = resources;
  sinon.stub(orchestrator, '_saveClusters').resolves();
  harnesses.push(resources);
  return resources;
}

let clock;
let tempDir;
let harnesses;

function useHarnessLifecycle() {
  beforeEach(function () {
    tempDir = createTempDirectory('zeroshot-conductor-watchdog-');
    harnesses = [];
    clock = sinon.useFakeTimers({ now: 1_000 });
    sinon.stub(console, 'error');
  });

  afterEach(function () {
    for (const harness of harnesses) {
      closeSqliteOrchestrator(harness);
    }
    clock.restore();
    sinon.restore();
    removeTempDirectory(tempDir);
  });
}

describe('Orchestrator conductor watchdog timer lifecycle', function () {
  useHarnessLifecycle();

  it('replaces the older timer when conductor completion repeats', function () {
    const { orchestrator, messageBus } = createHarness(tempDir, harnesses, 'repeated-completion');
    orchestrator._registerConductorWatchdog(messageBus, 'repeated-completion');

    publishConductorCompletion(messageBus, 'repeated-completion');
    clock.tick(1_000);
    publishConductorCompletion(messageBus, 'repeated-completion');

    clock.tick(29_000);
    assert.strictEqual(watchdogFailures(messageBus, 'repeated-completion').length, 0);

    clock.tick(1_000);
    assert.strictEqual(watchdogFailures(messageBus, 'repeated-completion').length, 1);
  });

  it('clears idempotently when CLUSTER_OPERATIONS arrives', function () {
    const { orchestrator, messageBus } = createHarness(tempDir, harnesses, 'operations-arrived');
    orchestrator._registerConductorWatchdog(messageBus, 'operations-arrived');
    sinon.stub(orchestrator, '_handleOperations').resolves();
    orchestrator._registerClusterOperationsHandler(messageBus, 'operations-arrived', null, null);

    publishConductorCompletion(messageBus, 'operations-arrived');
    publishClusterOperations(messageBus, 'operations-arrived');
    publishClusterOperations(messageBus, 'operations-arrived');
    clock.tick(30_000);

    assert.strictEqual(watchdogFailures(messageBus, 'operations-arrived').length, 0);
  });

  it('does not hide a real query failure while the cluster is live', function () {
    const { orchestrator, messageBus } = createHarness(tempDir, harnesses, 'live-query-failure');
    orchestrator._registerConductorWatchdog(messageBus, 'live-query-failure');
    publishConductorCompletion(messageBus, 'live-query-failure');
    sinon.stub(messageBus, 'query').throws(new Error('live ledger read failed'));

    assert.throws(() => clock.tick(30_000), /live ledger read failed/);
  });

  it('clears the current timer on stop while keeping the resumable subscription', async function () {
    const { orchestrator, messageBus, cluster } = createHarness(
      tempDir,
      harnesses,
      'stopped-cluster'
    );
    orchestrator._registerConductorWatchdog(messageBus, 'stopped-cluster');
    publishConductorCompletion(messageBus, 'stopped-cluster');

    await orchestrator.stop('stopped-cluster');
    clock.tick(30_000);
    assert.strictEqual(watchdogFailures(messageBus, 'stopped-cluster').length, 0);

    cluster.state = 'running';
    orchestrator._resumeConductorWatchdog('stopped-cluster');
    publishConductorCompletion(messageBus, 'stopped-cluster');
    clock.tick(30_000);
    assert.strictEqual(watchdogFailures(messageBus, 'stopped-cluster').length, 1);
  });

  it('does not rearm from a conductor completion emitted during stop', async function () {
    const { orchestrator, messageBus, cluster } = createHarness(
      tempDir,
      harnesses,
      'completion-during-stop'
    );
    orchestrator._registerConductorWatchdog(messageBus, 'completion-during-stop');
    publishConductorCompletion(messageBus, 'completion-during-stop');
    cluster.agents.push({
      stop() {
        publishConductorCompletion(messageBus, 'completion-during-stop');
      },
    });

    await orchestrator.stop('completion-during-stop');
    clock.tick(30_000);

    assert.strictEqual(watchdogFailures(messageBus, 'completion-during-stop').length, 0);
  });

  for (const topic of ['CLUSTER_COMPLETE', 'CLUSTER_FAILED']) {
    it(`clears before ${topic} stops the cluster`, async function () {
      const clusterId = `terminal-${topic.toLowerCase()}`;
      const { orchestrator, messageBus, cluster } = createHarness(tempDir, harnesses, clusterId);
      orchestrator._registerClusterCompletionHandlers(messageBus, clusterId);
      orchestrator._registerConductorWatchdog(messageBus, clusterId);
      publishConductorCompletion(messageBus, clusterId);
      const failuresBefore = watchdogFailures(messageBus, clusterId).length;

      publishTerminal(messageBus, clusterId, topic);
      await clock.tickAsync(0);
      assert.strictEqual(cluster.state, 'stopped');

      clock.tick(30_000);
      assert.strictEqual(watchdogFailures(messageBus, clusterId).length, failuresBefore);
    });
  }
});

describe('Orchestrator conductor watchdog teardown', function () {
  useHarnessLifecycle();

  for (const action of ['stop', 'kill']) {
    it(`rearms after CLUSTER_OPERATIONS interrupts a failed remote ${action}`, async function () {
      const clusterId = `failed-${action}-after-operations`;
      const { orchestrator, messageBus } = createHarness(tempDir, harnesses, clusterId);
      orchestrator._registerConductorWatchdog(messageBus, clusterId);
      sinon.stub(orchestrator, '_handleOperations').resolves();
      orchestrator._registerClusterOperationsHandler(messageBus, clusterId, null, null);
      publishConductorCompletion(messageBus, clusterId);
      clock.tick(5_000);

      const remoteSignal = deferred();
      sinon.stub(orchestrator, '_signalRemoteCluster').returns(remoteSignal.promise);
      const lifecycle = orchestrator[action](clusterId);
      publishConductorCompletion(messageBus, clusterId);
      publishClusterOperations(messageBus, clusterId);
      await clock.tickAsync(0);

      remoteSignal.reject(new Error(`remote ${action} failed`));
      await assert.rejects(lifecycle, { message: `remote ${action} failed` });
      clock.tick(30_000);
      assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 0);

      publishConductorCompletion(messageBus, clusterId);
      clock.tick(30_000);
      assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 1);
    });
  }

  it('does not let an older failed stop resume a newer pause owner', async function () {
    const clusterId = 'overlapping-failed-stops';
    const { orchestrator, messageBus } = createHarness(tempDir, harnesses, clusterId);
    orchestrator._registerConductorWatchdog(messageBus, clusterId);
    publishConductorCompletion(messageBus, clusterId);

    const firstSignal = deferred();
    const secondSignal = deferred();
    sinon
      .stub(orchestrator, '_signalRemoteCluster')
      .onFirstCall()
      .returns(firstSignal.promise)
      .onSecondCall()
      .returns(secondSignal.promise);
    const firstStop = orchestrator.stop(clusterId);
    const secondStop = orchestrator.stop(clusterId);

    firstSignal.reject(new Error('first stop failed'));
    await assert.rejects(firstStop, /first stop failed/);
    publishConductorCompletion(messageBus, clusterId);
    clock.tick(30_000);
    assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 0);

    secondSignal.reject(new Error('second stop failed'));
    await assert.rejects(secondStop, /second stop failed/);
    publishConductorCompletion(messageBus, clusterId);
    clock.tick(30_000);
    assert.strictEqual(watchdogFailures(messageBus, clusterId).length, 1);
  });

  it('disposes before kill closes the SQLite ledger', async function () {
    const { orchestrator, ledger, messageBus } = createHarness(
      tempDir,
      harnesses,
      'killed-cluster'
    );
    orchestrator._registerConductorWatchdog(messageBus, 'killed-cluster');
    publishConductorCompletion(messageBus, 'killed-cluster');
    const querySpy = sinon.spy(messageBus, 'query');

    await orchestrator.kill('killed-cluster');

    assert.strictEqual(messageBus._closed, true);
    assert.strictEqual(ledger._closed, true);
    assert.strictEqual(orchestrator._conductorWatchdogs.size, 0);
    assert.doesNotThrow(() => clock.tick(30_000));
    assert.strictEqual(querySpy.callCount, 0);
  });

  it('restores the pending timer when kill fails before teardown', async function () {
    const { orchestrator, messageBus } = createHarness(tempDir, harnesses, 'failed-kill');
    orchestrator._registerConductorWatchdog(messageBus, 'failed-kill');
    publishConductorCompletion(messageBus, 'failed-kill');
    clock.tick(5_000);
    sinon.stub(orchestrator, '_signalRemoteCluster').rejects(new Error('remote kill failed'));

    await assert.rejects(orchestrator.kill('failed-kill'), /remote kill failed/);

    assert.strictEqual(orchestrator._conductorWatchdogs.size, 1);
    clock.tick(24_999);
    assert.strictEqual(watchdogFailures(messageBus, 'failed-kill').length, 0);
    clock.tick(1);
    assert.strictEqual(watchdogFailures(messageBus, 'failed-kill').length, 1);
  });

  it('disposes before orchestrator close tears down the ledger', function () {
    const { orchestrator, ledger, messageBus } = createHarness(
      tempDir,
      harnesses,
      'closed-orchestrator'
    );
    orchestrator._registerConductorWatchdog(messageBus, 'closed-orchestrator');
    publishConductorCompletion(messageBus, 'closed-orchestrator');
    const querySpy = sinon.spy(messageBus, 'query');

    orchestrator.close();

    assert.strictEqual(messageBus._closed, true);
    assert.strictEqual(ledger._closed, true);
    assert.strictEqual(orchestrator._conductorWatchdogs.size, 0);
    assert.doesNotThrow(() => clock.tick(30_000));
    assert.strictEqual(querySpy.callCount, 0);
  });

  it('disposes a watchdog armed during startup rollback', async function () {
    const clusterId = 'startup-rollback';
    const orchestrator = new Orchestrator({ quiet: true, skipLoad: true, storageDir: tempDir });
    sinon.stub(orchestrator, '_saveClusters').resolves();
    let startupLedger;
    let startupMessageBus;
    let querySpy;
    sinon.stub(orchestrator, '_initializeClusterAgents').callsFake(({ cluster }) => {
      startupLedger = cluster.ledger;
      startupMessageBus = cluster.messageBus;
      querySpy = sinon.spy(startupMessageBus, 'query');
      cluster.agents.push({
        start() {
          publishConductorCompletion(startupMessageBus, clusterId);
          throw new Error('agent startup failed');
        },
        async stop() {},
      });
    });
    harnesses.push({ orchestrator, ledger: { close() {} } });

    await assert.rejects(
      orchestrator.start({ agents: [] }, { text: 'test' }, { clusterId }),
      /agent startup failed/
    );

    assert.strictEqual(startupMessageBus._closed, true);
    assert.strictEqual(startupLedger._closed, true);
    assert.strictEqual(orchestrator._conductorWatchdogs.size, 0);
    assert.doesNotThrow(() => clock.tick(30_000));
    assert.strictEqual(querySpy.callCount, 0);
  });
});
