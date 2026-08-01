'use strict';

const assert = require('assert');
const {
  createCurrentEngineAdapter,
  inputFromRequest,
  terminalEventFromMessage,
} = require('../../lib/cluster-worker/engine-adapter');

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
  const profile = {
    plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
    deployment: { worktree: true },
    provider: { config: { agents: [] }, settings: {} },
  };
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

  it('returns verified pull request identity in the bounded completion summary', () => {
    assert.deepStrictEqual(
      terminalEventFromMessage(
        terminalMessage('CLUSTER_COMPLETE', {
          reason: 'git-pusher-complete-verified',
          pr_number: 321,
          pr_url: 'https://github.com/the-open-engine/zeroshot/pull/321',
        })
      ),
      {
        type: 'complete',
        summary: 'Pull request #321 created: https://github.com/the-open-engine/zeroshot/pull/321',
      }
    );
  });

  it('subscribes before folding durable history and de-duplicates terminal truth', async () => {
    const complete = terminalMessage('CLUSTER_COMPLETE', { reason: 'done' });
    const state = harness([complete]);
    const events = [];
    await state.adapter.start({
      request: { source: 'prompt', prompt: 'task' },
      profile: state.profile,
      artifactManifest: { artifacts: [] },
      clusterId: 'cluster-1',
      onEvent: (event) => events.push(event),
    });
    state.emit(complete);
    assert.deepStrictEqual(events, [{ type: 'running' }, { type: 'complete', summary: 'done' }]);
    assert.deepStrictEqual(state.starts[0].options, { clusterId: 'cluster-1', worktree: true });
  });

  it('uses durable messages and cluster state instead of PID inference for status', async () => {
    const state = harness();
    const events = [];
    await state.adapter.start({
      request: { source: 'prompt', prompt: 'task' },
      profile: state.profile,
      artifactManifest: { artifacts: [] },
      clusterId: 'cluster-1',
      onEvent: (event) => events.push(event),
    });
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
    const startCluster = {
      buildTrustedStartOptions(value) {
        return { clusterId: value.clusterId, worktree: true };
      },
    };
    const adapter = createCurrentEngineAdapter({ orchestrator, startCluster });
    adapter.start({
      request: { source: 'prompt', prompt: 'task' },
      profile: {
        plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
        deployment: { worktree: true },
        provider: { config: { agents: [] }, settings: {} },
      },
      artifactManifest: { artifacts: [] },
      clusterId: 'cluster-pending',
      onEvent() {},
    });
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
    const adapter = createCurrentEngineAdapter({
      orchestrator,
      startCluster: {
        buildTrustedStartOptions(value) {
          return { clusterId: value.clusterId, worktree: true };
        },
      },
    });
    adapter.start({
      request: { source: 'prompt', prompt: 'task' },
      profile: {
        plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
        deployment: { worktree: true },
        provider: { config: { agents: [] }, settings: {} },
        bounds: { shutdownMs: 50 },
      },
      artifactManifest: { artifacts: [] },
      clusterId: 'cluster-late-allocation',
      onEvent() {},
    });
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
    const adapter = createCurrentEngineAdapter({
      orchestrator,
      startCluster: {
        buildTrustedStartOptions(value) {
          return { clusterId: value.clusterId, worktree: true };
        },
      },
    });
    adapter.start({
      request: { source: 'prompt', prompt: 'task' },
      profile: {
        plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
        deployment: { worktree: true },
        provider: { config: { agents: [] }, settings: {} },
        bounds: { shutdownMs: 5 },
      },
      artifactManifest: { artifacts: [] },
      clusterId: 'cluster-later-than-deadline',
      onEvent() {},
    });
    assert.deepStrictEqual(await adapter.stop(), { effective: false });
    await adapter.waitForCleanup();
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(cluster.state, 'stopped');
    assert.strictEqual(closeCalls, 1);
    adapter.close();
    assert.strictEqual(closeCalls, 1);
  });
});
