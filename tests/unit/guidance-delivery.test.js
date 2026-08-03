const fs = require('fs');
const os = require('os');
const path = require('path');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-guidance-'));

// task-lib/config.js binds ZEROSHOT_HOME when its module is loaded. Mocha reuses parallel workers,
// so changing that process-global root here would split later tests from their spawned children.

const assert = require('assert');

const Orchestrator = require('../../src/orchestrator');
const AgentWrapper = require('../../src/agent-wrapper');
const MessageBus = require('../../src/message-bus');
const Ledger = require('../../src/ledger');
const { USER_GUIDANCE_AGENT, USER_GUIDANCE_CLUSTER } = require('../../src/guidance-topics');
const { AttachServer } = require('../../src/attach');

describe('Guidance delivery', function () {
  this.timeout(10000);

  let orchestrator;
  let cluster;
  let agent;
  let ledger;

  beforeEach(() => {
    ledger = new Ledger(':memory:');
    const messageBus = new MessageBus(ledger);
    cluster = {
      id: 'guidance-cluster',
      messageBus,
      ledger,
      agents: [],
      config: {},
    };

    orchestrator = new Orchestrator({
      quiet: true,
      skipLoad: true,
      storageDir: path.join(storageRoot, 'clusters'),
    });

    agent = new AgentWrapper(
      {
        id: 'agent-1',
        role: 'implementation',
        modelLevel: 'level1',
        prompt: 'noop',
        triggers: [],
      },
      messageBus,
      cluster,
      { testMode: true }
    );

    cluster.agents.push(agent);
    orchestrator.clusters.set(cluster.id, cluster);
  });

  afterEach(() => {
    ledger.close();
    orchestrator.close();
    orchestrator.clusters.clear();
  });

  after(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('publishes unsupported delivery metadata when no live socket is available', async () => {
    const result = await orchestrator.sendGuidanceToAgent(cluster.id, agent.id, 'Use approach A');

    assert.strictEqual(result.status, 'unsupported');

    const messages = cluster.messageBus.query({
      cluster_id: cluster.id,
      topic: USER_GUIDANCE_AGENT,
    });

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].metadata.delivery.status, 'unsupported');
  });

  it('publishes injected delivery metadata when attach socket is live', async () => {
    const { addTask, ensureDirs, removeTask } = await import('../../task-lib/store.js');
    ensureDirs();

    const taskId = 'task-guidance-1';
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-guidance-sock-'));
    const socketPath = path.join(socketDir, 'attach.sock');

    const server = new AttachServer({
      id: taskId,
      socketPath,
      command: 'cat',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
    });

    let testError;
    let stopError;
    try {
      await server.start();

      addTask({
        id: taskId,
        prompt: 'test',
        fullPrompt: 'test',
        cwd: process.cwd(),
        status: 'running',
        pid: server.pid,
        sessionId: null,
        logFile: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: null,
        error: null,
        provider: 'claude',
        model: null,
        scheduleId: null,
        socketPath,
        attachable: true,
      });

      agent.currentTaskId = taskId;

      const result = await orchestrator.sendGuidanceToAgent(
        cluster.id,
        agent.id,
        'Injected guidance'
      );

      assert.strictEqual(result.status, 'injected');

      const messages = cluster.messageBus.query({
        cluster_id: cluster.id,
        topic: USER_GUIDANCE_AGENT,
      });

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].metadata.delivery.status, 'injected');
      assert.strictEqual(messages[0].metadata.delivery.method, 'pty');
      assert.strictEqual(messages[0].metadata.delivery.taskId, taskId);
    } catch (error) {
      testError = error;
    } finally {
      removeTask(taskId);
      try {
        await server.stop('SIGTERM');
      } catch (error) {
        console.warn('AttachServer.stop failed in guidance-delivery test', error);
        stopError = error;
      }
      fs.rmSync(socketDir, { recursive: true, force: true });
    }

    if (stopError && !testError) {
      throw stopError;
    }
    if (testError) {
      throw testError;
    }
  });

  it('broadcasts cluster guidance with per-agent delivery results', async () => {
    const { addTask, ensureDirs, removeTask } = await import('../../task-lib/store.js');
    ensureDirs();

    const taskId = 'task-guidance-cluster-1';
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-guidance-cluster-sock-'));
    const socketPath = path.join(socketDir, 'attach.sock');

    const server = new AttachServer({
      id: taskId,
      socketPath,
      command: 'cat',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
    });

    const agentTwo = new AgentWrapper(
      {
        id: 'agent-2',
        role: 'implementation',
        modelLevel: 'level1',
        prompt: 'noop',
        triggers: [],
      },
      cluster.messageBus,
      cluster,
      { testMode: true }
    );

    cluster.agents.push(agentTwo);

    let testError;
    let stopError;
    try {
      await server.start();

      addTask({
        id: taskId,
        prompt: 'test',
        fullPrompt: 'test',
        cwd: process.cwd(),
        status: 'running',
        pid: server.pid,
        sessionId: null,
        logFile: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: null,
        error: null,
        provider: 'claude',
        model: null,
        scheduleId: null,
        socketPath,
        attachable: true,
      });

      agent.currentTaskId = taskId;

      const result = await orchestrator.sendGuidanceToCluster(
        cluster.id,
        'Cluster guidance message'
      );

      assert.deepStrictEqual(result.summary, { injected: 1, queued: 1, total: 2 });
      assert.strictEqual(result.agents[agent.id].status, 'injected');
      assert.strictEqual(result.agents[agent.id].method, 'pty');
      assert.strictEqual(result.agents[agent.id].taskId, taskId);
      assert.strictEqual(result.agents[agentTwo.id].status, 'unsupported');
      assert.ok(result.agents[agentTwo.id].reason);

      const clusterMessages = cluster.messageBus.query({
        cluster_id: cluster.id,
        topic: USER_GUIDANCE_CLUSTER,
      });
      const agentMessages = cluster.messageBus.query({
        cluster_id: cluster.id,
        topic: USER_GUIDANCE_AGENT,
      });

      assert.strictEqual(clusterMessages.length, 1);
      assert.strictEqual(agentMessages.length, 0);

      const deliveryMeta = clusterMessages[0].metadata.delivery;
      assert.deepStrictEqual(deliveryMeta.summary, { injected: 1, queued: 1, total: 2 });
      assert.strictEqual(deliveryMeta.agents[agent.id].status, 'injected');
      assert.strictEqual(deliveryMeta.agents[agentTwo.id].status, 'unsupported');
    } catch (error) {
      testError = error;
    } finally {
      removeTask(taskId);
      try {
        await server.stop('SIGTERM');
      } catch (error) {
        console.warn('AttachServer.stop failed in guidance-delivery test', error);
        stopError = error;
      }
      fs.rmSync(socketDir, { recursive: true, force: true });
    }

    if (stopError && !testError) {
      throw stopError;
    }
    if (testError) {
      throw testError;
    }
  });
});
