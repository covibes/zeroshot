const assert = require('assert');
const path = require('node:path');

const {
  addAgentsToState,
  cloneAgentConfigs,
} = require('../../src/template-validation/random-topology-state');
const {
  handleClusterOperationsMessage,
} = require('../../src/template-validation/random-topology-operations');
const { runMessageLoop } = require('../../src/template-validation/random-topology-message-loop');

function createState(agentConfigs = []) {
  return {
    agentConfigs,
    cluster: {
      id: 'boundary-test',
      agents: agentConfigs.map((agent) => ({ id: agent.id, role: agent.role })),
    },
  };
}

function createMessageBus(published, queue) {
  return {
    publish(message) {
      published.push(message);
      if (queue) queue.push(message);
      return message;
    },
  };
}

function createLoopContext(state, messageBus, queue) {
  return {
    state,
    messageBus,
    logicEngine: {},
    iterations: new Map(),
    rng: () => 0.5,
    queue,
    templatesDir: path.join(__dirname, '..', '..', 'cluster-templates'),
    startedAt: Date.now(),
    maxSteps: 10,
    maxScenarioMs: 1000,
  };
}

describe('random topology state boundaries', function () {
  it('deep-clones only valid agent configs', function () {
    const source = [
      { id: 'alpha', role: 'worker', metadata: { nested: true } },
      { role: 'missing-id' },
      { id: 'invalid-role', role: 42 },
      null,
    ];

    const cloned = cloneAgentConfigs(source);

    assert.deepStrictEqual(cloned, [source[0]]);
    assert.notStrictEqual(cloned[0], source[0]);
    assert.notStrictEqual(cloned[0].metadata, source[0].metadata);
  });

  it('adds valid unique agents to both state views', function () {
    const state = createState();

    addAgentsToState(state, [
      { id: 'alpha', role: 'worker' },
      { id: 'alpha', role: 'replacement' },
      { id: 'invalid-role', role: 42 },
      { id: 'beta' },
      null,
    ]);

    assert.deepStrictEqual(state.agentConfigs, [{ id: 'alpha', role: 'worker' }, { id: 'beta' }]);
    assert.deepStrictEqual(state.cluster.agents, [
      { id: 'alpha', role: 'worker' },
      { id: 'beta', role: undefined },
    ]);
  });
});

describe('random topology operation boundaries', function () {
  it('guards dynamic agent inputs while applying valid operations', function () {
    const state = createState([{ id: 'alpha', role: 'worker' }]);
    const published = [];
    const messageBus = createMessageBus(published);
    const message = {
      topic: 'CLUSTER_OPERATIONS',
      content: {
        data: {
          operations: JSON.stringify([
            {
              action: 'add_agents',
              agents: [{ id: 'beta', role: 'reviewer' }, { id: 7 }],
            },
            { action: 'update_agent', agentId: 'alpha', updates: 'invalid' },
            {
              action: 'update_agent',
              agentId: 'beta',
              updates: { role: 'validator', maxIterations: 3 },
            },
            { action: 'remove_agents', agentIds: 'beta' },
            { action: 'publish', topic: 'WORK_READY', content: { data: { ok: true } } },
          ]),
        },
      },
    };

    handleClusterOperationsMessage(state, messageBus, message, '/unused');

    assert.deepStrictEqual(state.agentConfigs, [
      { id: 'alpha', role: 'worker' },
      { id: 'beta', role: 'validator', maxIterations: 3 },
    ]);
    assert.deepStrictEqual(state.cluster.agents, [
      { id: 'alpha', role: 'worker' },
      { id: 'beta', role: 'reviewer' },
    ]);
    assert.deepStrictEqual(published, [
      {
        cluster_id: 'boundary-test',
        topic: 'WORK_READY',
        sender: '__sim_orchestrator__',
        receiver: 'broadcast',
        content: { data: { ok: true } },
        metadata: { fromTopic: 'CLUSTER_OPERATIONS' },
      },
    ]);
  });
});

describe('random topology dispatch boundaries', function () {
  it('routes a matching stop trigger through the terminal message boundary', async function () {
    const state = createState([
      {
        id: 'stopper',
        role: 'orchestrator',
        triggers: [{ topic: 'WORK_FINISHED', action: 'stop_cluster' }],
      },
    ]);
    const queue = [{ topic: 'WORK_FINISHED', content: { data: {} } }];
    const published = [];
    const messageBus = createMessageBus(published, queue);

    const outcome = await runMessageLoop(createLoopContext(state, messageBus, queue));

    assert.deepStrictEqual(outcome, { ok: true });
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].topic, 'CLUSTER_COMPLETE');
    assert.strictEqual(published[0].sender, 'stopper');
  });
});
