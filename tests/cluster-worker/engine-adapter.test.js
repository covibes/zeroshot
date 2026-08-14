'use strict';

const assert = require('assert');
const {
  createCurrentEngineAdapter,
  inputFromRequest,
  terminalEventFromMessage,
} = require('../../lib/cluster-worker/engine-adapter');
const { MAX_SUMMARY_BYTES } = require('../../lib/cluster-worker/contracts');

function worktreeProfile(overrides = {}) {
  return {
    plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
    deployment: { worktree: true },
    provider: { config: { agents: [] }, settings: {} },
    ...overrides,
  };
}

function harness(initialMessages = []) {
  let subscriber;
  const messages = [...initialMessages];
  const cluster = { state: 'running', ledger: { count: () => messages.length } };
  const messageBus = {
    subscribe(callback) {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    },
    getAll() {
      return [...messages];
    },
  };
  const starts = [];
  const orchestrator = {
    start(config, input, options) {
      starts.push({ config, input, options });
      return { id: 'cluster-1', messageBus };
    },
    getCluster() {
      return cluster;
    },
    getStatus() {
      return { isZombie: false };
    },
    stop() {
      cluster.state = 'stopped';
    },
    close() {},
  };
  const startCluster = {
    buildTrustedStartOptions(value) {
      return { clusterId: value.clusterId, worktree: true };
    },
  };
  const profile = worktreeProfile();
  return {
    adapter: createCurrentEngineAdapter({ orchestrator, startCluster }),
    cluster,
    emit(message) {
      messages.push(message);
      subscriber?.(message);
    },
    profile,
    starts,
  };
}

function terminalMessage(topic, data = {}) {
  return {
    id: `${topic}-1`,
    cluster_id: 'cluster-1',
    topic,
    sender: 'engine',
    content: { data },
  };
}

function engineStart(profile, clusterId, onEvent = () => {}) {
  return {
    request: { source: 'prompt', prompt: 'task' },
    profile,
    artifactManifest: { artifacts: [] },
    clusterId,
    onEvent,
  };
}

function adapterFor(orchestrator) {
  return createCurrentEngineAdapter({
    orchestrator,
    startCluster: {
      buildTrustedStartOptions(value) {
        return { clusterId: value.clusterId, worktree: true };
      },
    },
  });
}

describe('legacy cluster worker engine adapter', () => {
  it('defers production engine allocation until start', () => {
    let allocations = 0;
    class DeferredOrchestrator {
      constructor() {
        allocations += 1;
      }
    }
    const adapter = createCurrentEngineAdapter({ Orchestrator: DeferredOrchestrator });
    assert.strictEqual(allocations, 0);
    assert.strictEqual(adapter.status(), null);
  });

  it('validates inline configs when a private provider profile requires it', async () => {
    let started = false;
    const adapter = createCurrentEngineAdapter({
      orchestrator: {
        validateConfig: () => ({ valid: false, errors: ['closed validation failure'] }),
        start() {
          started = true;
        },
        close() {},
      },
    });
    await assert.rejects(
      adapter.start(
        engineStart(
          worktreeProfile({
            provider: { config: { agents: [] }, validateConfig: true, settings: {} },
          }),
          'cluster-invalid-inline'
        )
      ),
      /closed validation failure/
    );
    assert.strictEqual(started, false);
  });

  it('maps closed request sources without adding an interactive input path', () => {
    assert.deepStrictEqual(inputFromRequest({ source: 'issue', issue: 'issue-1' }), {
      issue: 'issue-1',
    });
    assert.deepStrictEqual(inputFromRequest({ source: 'prompt', prompt: 'task' }), {
      text: 'task',
    });
    const artifactInput = inputFromRequest({ source: 'artifact' }, { artifacts: [] });
    assert.match(artifactInput.text, /byte-free artifact manifest/);
    assert.strictEqual(artifactInput.guidance, undefined);
  });

  it('normalizes durable terminal topics and ignores raw output', () => {
    assert.deepStrictEqual(
      terminalEventFromMessage(
        terminalMessage('CLUSTER_COMPLETE', { reason: 'done', rawOutput: 'private' })
      ),
      { type: 'complete', summary: 'done' }
    );
    assert.deepStrictEqual(
      terminalEventFromMessage(
        terminalMessage('CLUSTER_FAILED', {
          code: 'refusal',
          workerReason: 'policy_denied',
        })
      ),
      { type: 'failed', summary: undefined, code: 'refusal', reason: 'policy_denied' }
    );
  });

  it('bounds model-authored completion text without splitting Unicode', () => {
    const message = terminalMessage('CLUSTER_COMPLETE');
    message.content.text = `${'a'.repeat(MAX_SUMMARY_BYTES - 2)}🙂tail`;
    const event = terminalEventFromMessage(message);
    assert.strictEqual(event.type, 'complete');
    assert.strictEqual(event.summary, 'a'.repeat(MAX_SUMMARY_BYTES - 2));
    assert.strictEqual(Buffer.byteLength(event.summary, 'utf8'), MAX_SUMMARY_BYTES - 2);

    assert.deepStrictEqual(terminalEventFromMessage(terminalMessage('CLUSTER_COMPLETE')), {
      type: 'complete',
      summary: 'Cluster completed',
    });
  });

  it('subscribes before folding durable history and de-duplicates terminal truth', async () => {
    const complete = terminalMessage('CLUSTER_COMPLETE', { reason: 'done' });
    const state = harness([complete]);
    const events = [];
    await state.adapter.start(
      engineStart(state.profile, 'cluster-1', (event) => events.push(event))
    );
    state.emit(complete);
    assert.deepStrictEqual(events, [{ type: 'running' }, { type: 'complete', summary: 'done' }]);
    assert.deepStrictEqual(state.starts[0].options, { clusterId: 'cluster-1', worktree: true });
  });

  it('uses durable messages and cluster state instead of PID inference for status', async () => {
    const state = harness();
    const events = [];
    await state.adapter.start(
      engineStart(state.profile, 'cluster-1', (event) => events.push(event))
    );
    state.cluster.state = 'failed';
    assert.strictEqual(state.adapter.status().state, 'failed');
    assert.deepStrictEqual(events.at(-1), {
      type: 'failed',
      code: 'crash',
      reason: 'declared_failure',
    });
  });

  it('stops an allocated cluster while orchestrator start remains pending', async () => {
    let stopCalls = 0;
    const cluster = { state: 'initializing' };
    const orchestrator = {
      start() {
        return new Promise(() => {});
      },
      getCluster(clusterId) {
        assert.strictEqual(clusterId, 'cluster-pending');
        return cluster;
      },
      stop(clusterId) {
        assert.strictEqual(clusterId, 'cluster-pending');
        stopCalls += 1;
        cluster.state = 'stopped';
      },
      close() {},
    };
    const adapter = adapterFor(orchestrator);
    adapter.start(engineStart(worktreeProfile(), 'cluster-pending'));
    assert.deepStrictEqual(await adapter.stop(), { effective: true });
    assert.strictEqual(stopCalls, 1);
  });

  it('stops a cluster allocated after cancellation while start remains pending', async () => {
    let cluster = null;
    let stopCalls = 0;
    const orchestrator = {
      start() {
        setImmediate(() => {
          cluster = { state: 'initializing' };
        });
        return new Promise(() => {});
      },
      getCluster() {
        return cluster;
      },
      stop() {
        stopCalls += 1;
        cluster.state = 'stopped';
      },
      close() {},
    };
    const adapter = adapterFor(orchestrator);
    adapter.start(
      engineStart(worktreeProfile({ bounds: { shutdownMs: 50 } }), 'cluster-late-allocation')
    );
    assert.deepStrictEqual(await adapter.stop(), { effective: true });
    assert.strictEqual(stopCalls, 1);
  });

  it('keeps cleanup armed when allocation occurs after the caller shutdown deadline', async () => {
    let cluster = null;
    let closeCalls = 0;
    let stopCalls = 0;
    const orchestrator = {
      start() {
        setTimeout(() => {
          cluster = { state: 'initializing' };
        }, 30);
        return new Promise(() => {});
      },
      getCluster() {
        return cluster;
      },
      stop() {
        stopCalls += 1;
        cluster.state = 'stopped';
      },
      close() {
        closeCalls += 1;
      },
    };
    const adapter = adapterFor(orchestrator);
    adapter.start(
      engineStart(worktreeProfile({ bounds: { shutdownMs: 5 } }), 'cluster-later-than-deadline')
    );
    assert.deepStrictEqual(await adapter.stop(), { effective: false });
    await adapter.waitForCleanup();
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(cluster.state, 'stopped');
    assert.strictEqual(closeCalls, 1);
    adapter.close();
    assert.strictEqual(closeCalls, 1);
  });
});
