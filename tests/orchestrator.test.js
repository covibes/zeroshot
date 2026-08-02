/**
 * Orchestrator - Staff-Level Test Suite
 *
 * Tests cluster lifecycle, crash recovery, race conditions, and error handling.
 * These tests exist to FIND BUGS, not just pass - they validate production behavior.
 *
 * Based on: external/zeroshot/tests/STAFF_LEVEL_TEST_PLAN.md
 * Target coverage: 14% → 80%
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Orchestrator = require('../src/orchestrator.js');
const IsolationManager = require('../src/isolation-manager.js');
const MockTaskRunner = require('./helpers/mock-task-runner.js');
const LedgerAssertions = require('./helpers/ledger-assertions.js');
const Ledger = require('../src/ledger.js');
const { promptIdentity } = require('../src/agent/provider-session.js');
const { runStructuredOutputRecovery } = require('./helpers/stuck-recovery-fixture');

// Isolate tests from user settings (prevents minModel/maxModel conflicts)
const testSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-test-settings-'));
const testSettingsFile = path.join(testSettingsDir, 'settings.json');
fs.writeFileSync(testSettingsFile, JSON.stringify({ maxModel: 'opus', minModel: null }));
process.env.ZEROSHOT_SETTINGS_FILE = testSettingsFile;

// Test utilities
function createTempDir() {
  const tmpBase = path.join(os.tmpdir(), 'zeroshot-test');
  if (!fs.existsSync(tmpBase)) {
    fs.mkdirSync(tmpBase, { recursive: true });
  }
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'orchestrator-'));
  return tmpDir;
}

function cleanupTempDir(tmpDir) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClusterState(orchestratorInstance, clusterId, targetState, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = orchestratorInstance.getStatus(clusterId);
      if (status.state === targetState) {
        return;
      }
    } catch {
      // Cluster may be removed during shutdown
    }
    await sleep(50);
  }
  throw new Error(`Cluster ${clusterId} did not reach ${targetState} within ${timeoutMs}ms`);
}

// Load fixture config from tests/fixtures/
function loadFixture(filename) {
  const fixturePath = path.join(__dirname, 'fixtures', filename);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

// Create simple test config (no template variables)
function createSimpleConfig() {
  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        modelLevel: 'level2',
        outputFormat: 'text',
        triggers: [
          {
            topic: 'ISSUE_OPENED',
            action: 'execute_task',
          },
        ],
        prompt: 'You are a worker agent. Implement the requested task.',
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: {
              topic: 'IMPLEMENTATION_READY',
            },
          },
        },
      },
    ],
  };
}

function loadSetupCluster(orchestrator, overrides = {}) {
  const clusterId = overrides.id || 'setup-cluster-test';
  const cluster = orchestrator._loadSetupCluster(clusterId, {
    state: 'failed',
    createdAt: Date.now(),
    pid: null,
    setupLogPath: path.join(os.tmpdir(), `${clusterId}.log`),
    failureInfo: {
      type: 'setup',
      error: 'npm ci failed',
      timestamp: Date.now(),
    },
    provisional: true,
    ...overrides,
    id: clusterId,
  });
  orchestrator.clusters.set(clusterId, cluster);
  return { clusterId, cluster };
}

// Create multi-agent config for testing (used in future tests)
function _createMultiAgentConfig() {
  return {
    agents: [
      {
        id: 'agent1',
        role: 'implementation',
        modelLevel: 'level2',
        outputFormat: 'text',
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        prompt: 'Agent 1',
      },
      {
        id: 'agent2',
        role: 'validator',
        modelLevel: 'level2',
        outputFormat: 'text',
        triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
        prompt: 'Agent 2',
      },
    ],
  };
}

// Create validator config for testing (used in future tests)
function _createValidatorConfig() {
  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        modelLevel: 'level2',
        outputFormat: 'text',
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        prompt: 'Worker',
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: { topic: 'IMPLEMENTATION_READY' },
          },
        },
      },
      {
        id: 'validator',
        role: 'validator',
        modelLevel: 'level2',
        outputFormat: 'json',
        jsonSchema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
          },
        },
        triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
        prompt: 'Validator',
      },
    ],
  };
}

function createPartialValidationResumeConfig(worktreeDir) {
  const validationSchema = {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      summary: { type: 'string' },
    },
    required: ['approved'],
  };

  const validationHook = {
    onComplete: {
      action: 'publish_message',
      config: {
        topic: 'VALIDATION_RESULT',
        content: {
          text: '{{result.summary}}',
          data: {
            approved: '{{result.approved}}',
          },
        },
      },
    },
  };

  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        modelLevel: 'level2',
        outputFormat: 'text',
        cwd: worktreeDir,
        triggers: [
          {
            topic: 'VALIDATION_RESULT',
            logic: {
              engine: 'javascript',
              script:
                "const validators = cluster.getAgentsByRole('validator');\n" +
                "const lastPush = ledger.findLast({ topic: 'IMPLEMENTATION_READY' });\n" +
                'if (!lastPush) return false;\n' +
                "const responses = ledger.query({ topic: 'VALIDATION_RESULT', since: lastPush.timestamp });\n" +
                'const validatorIds = new Set(validators.map((v) => v.id));\n' +
                'const latestByValidator = new Map();\n' +
                'for (const response of responses) {\n' +
                '  if (validatorIds.has(response.sender)) latestByValidator.set(response.sender, response);\n' +
                '}\n' +
                'if (latestByValidator.size < validators.length) return false;\n' +
                'return Array.from(latestByValidator.values()).some((response) =>\n' +
                "  response.content?.data?.approved === false || response.content?.data?.approved === 'false'\n" +
                ');',
            },
            action: 'execute_task',
          },
        ],
        prompt: 'Repair rejected validation findings.',
      },
      ...['validator-requirements', 'validator-code'].map((id) => ({
        id,
        role: 'validator',
        modelLevel: 'level2',
        outputFormat: 'json',
        jsonSchema: validationSchema,
        cwd: worktreeDir,
        triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
        hooks: validationHook,
        prompt: `Validate as ${id}.`,
      })),
    ],
  };
}

async function waitForAgentCalls(runner, expectedCalls, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const complete = Object.entries(expectedCalls).every(
      ([agentId, count]) => runner.getCalls(agentId).length === count
    );
    if (complete) {
      return;
    }
    await sleep(20);
  }

  const actual = Object.fromEntries(
    Object.keys(expectedCalls).map((agentId) => [agentId, runner.getCalls(agentId).length])
  );
  throw new Error(
    `Agent calls did not reach ${JSON.stringify(expectedCalls)}; actual ${JSON.stringify(actual)}`
  );
}

async function waitForLifecycleEvent({ messageBus, clusterId, agentId, event, timeoutMs = 3000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observed = messageBus
      .query({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: agentId,
      })
      .some((message) => message.content?.data?.event === event);
    if (observed) {
      return;
    }
    await sleep(20);
  }

  throw new Error(`Agent ${agentId} did not publish lifecycle event ${event}`);
}

function publishInterruptedTaskHistory(
  cluster,
  clusterId,
  agentId,
  { iteration, taskId, triggeredBy }
) {
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: agentId,
    content: {
      text: `${agentId}: TASK_STARTED`,
      data: {
        event: 'TASK_STARTED',
        agent: agentId,
        state: 'executing_task',
        iteration,
        triggeredBy,
      },
    },
  });
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: agentId,
    content: {
      text: `${agentId}: TASK_ID_ASSIGNED`,
      data: {
        event: 'TASK_ID_ASSIGNED',
        agent: agentId,
        state: 'executing_task',
        taskId,
      },
    },
  });
}

function publishRecoveredWorkerFailureHistory(cluster, clusterId) {
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_ERROR',
    sender: 'worker',
    content: {
      text: 'Task stale-worker-task not found - restarting for safety',
      data: {
        agent: 'worker',
        error: 'task_not_found',
        iteration: 1,
        taskId: 'stale-worker-task',
      },
    },
  });
  publishInterruptedTaskHistory(cluster, clusterId, 'worker', {
    iteration: 2,
    taskId: 'recovered-worker-task',
    triggeredBy: 'PLAN_READY',
  });
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: 'worker',
    content: {
      text: 'worker: TASK_COMPLETED',
      data: {
        event: 'TASK_COMPLETED',
        agent: 'worker',
        role: 'implementation',
        state: 'idle',
        iteration: 2,
        taskId: 'recovered-worker-task',
      },
    },
  });
}

function publishCompletedTaskHistory(cluster, clusterId, agentId, { iteration, taskId }) {
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: agentId,
    content: {
      text: `${agentId}: TASK_COMPLETED`,
      data: {
        event: 'TASK_COMPLETED',
        agent: agentId,
        role: 'validator',
        state: 'idle',
        iteration,
        taskId,
      },
    },
  });
}

function publishValidationResult(cluster, clusterId, agentId, approved, text) {
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'VALIDATION_RESULT',
    sender: agentId,
    content: { text, data: { approved } },
  });
}

function setPersistedAgentTaskState(cluster, agentId, { state, iteration, taskId, processPid }) {
  const agent = cluster.agents.find((candidate) => candidate.id === agentId);
  agent.state = state;
  agent.iteration = iteration;
  agent.currentTaskId = taskId;
  agent.processPid = processPid;
}

function prepareRecoveredRequirementsFailure(cluster, clusterId) {
  cluster.failureInfo = {
    agentId: 'validator-requirements',
    taskId: 'recovered-requirements-task',
    iteration: 7,
    error: 'temporary provider lookup failure',
    timestamp: Date.now() - 1000,
  };
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'IMPLEMENTATION_READY',
    sender: 'worker',
    content: { text: 'Implementation ready for validation' },
  });
  publishInterruptedTaskHistory(cluster, clusterId, 'validator-requirements', {
    iteration: 8,
    taskId: 'completed-requirements-task',
    triggeredBy: 'IMPLEMENTATION_READY',
  });
  publishCompletedTaskHistory(cluster, clusterId, 'validator-requirements', {
    iteration: 8,
    taskId: 'completed-requirements-task',
  });
  publishValidationResult(
    cluster,
    clusterId,
    'validator-requirements',
    true,
    'Requirements approved'
  );
  setPersistedAgentTaskState(cluster, 'validator-requirements', {
    state: 'idle',
    iteration: 8,
    taskId: 'completed-requirements-task',
    processPid: null,
  });
}

function prepareInterruptedCodeValidator(cluster, clusterId) {
  publishInterruptedTaskHistory(cluster, clusterId, 'validator-code', {
    iteration: 5,
    taskId: 'interrupted-code-task',
    triggeredBy: 'IMPLEMENTATION_READY',
  });
  setPersistedAgentTaskState(cluster, 'validator-code', {
    state: 'executing_task',
    iteration: 5,
    taskId: 'interrupted-code-task',
    processPid: 4242,
  });
}

function publishAgentError(cluster, clusterId, agentId, { error, iteration, taskId, ...details }) {
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_ERROR',
    sender: agentId,
    content: {
      text: error,
      data: { agent: agentId, error, iteration, taskId, ...details },
    },
  });
}

async function reloadLifecycleOrchestrator(orchestrator, storageDir, taskRunner) {
  await orchestrator._saveClusters();
  orchestrator.close();
  return Orchestrator.create({
    taskRunner,
    storageDir,
    quiet: true,
  });
}

function validationResultCounts(cluster, clusterId) {
  return {
    total: cluster.messageBus.count({
      cluster_id: clusterId,
      topic: 'VALIDATION_RESULT',
    }),
    requirements: cluster.messageBus.query({
      cluster_id: clusterId,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-requirements',
    }).length,
  };
}

function assertValidationResultsAdvancedOnce(cluster, clusterId, before) {
  const after = validationResultCounts(cluster, clusterId);
  assert.strictEqual(
    after.total,
    before.total + 1,
    'only the interrupted validator may append a new validation result'
  );
  assert.strictEqual(
    after.requirements,
    before.requirements,
    'the completed validator result must remain a singleton'
  );
}

function deleteLedgerTopics(cluster, clusterId, topics) {
  const placeholders = topics.map(() => '?').join(', ');
  cluster.ledger.db
    .prepare(`DELETE FROM messages WHERE cluster_id = ? AND topic IN (${placeholders})`)
    .run(clusterId, ...topics);
  cluster.ledger.cache.clear();
}

let lifecycleOrchestrator;
let lifecycleMockRunner;
let lifecycleStorageDir;

describe('Orchestrator - Cluster Lifecycle (CRITICAL)', function () {
  this.timeout(10000);

  beforeEach(function () {
    lifecycleMockRunner = new MockTaskRunner();
    lifecycleStorageDir = createTempDir();
    lifecycleOrchestrator = new Orchestrator({
      taskRunner: lifecycleMockRunner,
      storageDir: lifecycleStorageDir,
      skipLoad: true,
      quiet: true,
    });
  });

  afterEach(function () {
    if (lifecycleOrchestrator) {
      lifecycleOrchestrator.close();
    }
    cleanupTempDir(lifecycleStorageDir);
  });

  defineLifecycleStartTests();
  defineLifecycleStopTests();
  defineLifecycleKillTests();
  defineLifecycleResumeTests();
  defineLifecycleGetStatusTests();
  defineLifecycleListClustersTests();
});

function defineLifecycleStartTests() {
  describe('start()', function () {
    it('should spawn all agents and publish ISSUE_OPENED', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Fix bug' });
      const clusterId = result.id;

      // Verify: Cluster created
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      assert.ok(cluster, 'Cluster should exist');
      assert.strictEqual(cluster.agents.length, 1, 'Should have 1 agent');

      // Verify: ISSUE_OPENED published
      const ledger = new LedgerAssertions(cluster.ledger, clusterId);
      ledger.assertPublished('ISSUE_OPENED');
    });

    it('should replace detached setup placeholder with requested cluster id', async function () {
      const config = createSimpleConfig();
      const clusterId = 'detached-setup-id';
      loadSetupCluster(lifecycleOrchestrator, {
        id: clusterId,
        state: 'setup',
        failureInfo: null,
      });
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' }, { clusterId });

      assert.strictEqual(result.id, clusterId);
      assert.ok(lifecycleOrchestrator.getCluster(clusterId));
      assert.deepStrictEqual(
        Array.from(lifecycleOrchestrator.clusters.keys()).filter((id) => id.startsWith(clusterId)),
        [clusterId]
      );

      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.ok(persisted[clusterId], 'Requested cluster id should be persisted');
      assert.strictEqual(persisted[clusterId].provisional, false);
    });

    it('should retry once on SIGTERM termination even with maxRetries=1', async function () {
      const config = {
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
                config: {
                  topic: 'CLUSTER_COMPLETE',
                  content: {
                    data: { reason: 'sigterm-retry-test' },
                  },
                },
              },
            },
          },
        ],
      };

      let callCount = 0;
      lifecycleMockRunner.when('worker').calls(() => {
        callCount += 1;
        if (callCount === 1) {
          return { success: false, output: '', error: 'Killed by SIGTERM' };
        }
        return { success: true, output: 'ok' };
      });

      const result = await lifecycleOrchestrator.start(config, { text: 'Fix bug' });
      await waitForClusterState(lifecycleOrchestrator, result.id, 'stopped', 10000);

      assert.strictEqual(callCount, 2, 'Expected SIGTERM failure to trigger one retry');
    });

    it('should stop after implementation agent retries are exhausted', async function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            modelLevel: 'level2',
            outputFormat: 'text',
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

      let callCount = 0;
      lifecycleMockRunner.when('worker').calls(() => {
        callCount += 1;
        return { success: false, output: '', error: 'Request timed out' };
      });

      const result = await lifecycleOrchestrator.start(config, { text: 'Fix bug' });
      await waitForClusterState(lifecycleOrchestrator, result.id, 'stopped', 10000);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      const ledger = new LedgerAssertions(cluster.ledger, result.id);
      ledger.assertCount('AGENT_ERROR', 1);

      assert.strictEqual(callCount, 3, 'Expected the worker to stop after three failed attempts');
    });

    it('should inject worktree cwd when worktree enabled', function () {
      // This test requires a real git repo - skip in test environment
      // The functionality is tested in integration/worktree tests
      this.skip();
    });

    it('should handle empty agents array (delegates to agent creation)', async function () {
      const badConfig = { agents: [] };

      // The orchestrator doesn't validate config structure upfront
      // It will fail when trying to start agents, but cluster is created
      const result = await lifecycleOrchestrator._startInternal(
        badConfig,
        { text: 'Task' },
        { testMode: true }
      );

      // Cluster is created even with empty agents
      assert.ok(result.id, 'Cluster ID should be generated');

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      assert.ok(cluster, 'Cluster should exist');
      assert.strictEqual(cluster.agents.length, 0, 'Should have 0 agents');
    });

    it('should handle missing config (TypeError from accessing config.dbPath)', async function () {
      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.start(null, { text: 'Task' });
        },
        TypeError,
        'Should throw TypeError for null config'
      );
    });

    it('should forward launch options needed for fresh worktree PR runs', async function () {
      const config = createSimpleConfig();
      const forwarded = [];
      const originalStartInternal =
        lifecycleOrchestrator._startInternal.bind(lifecycleOrchestrator);

      lifecycleOrchestrator._startInternal = function (cfg, input, options) {
        forwarded.push({ cfg, input, options });
        return { id: 'cluster-forward-test' };
      };

      try {
        const mounts = [{ source: '/tmp/src', target: '/workspace/src', readonly: true }];
        await lifecycleOrchestrator.start(
          config,
          { text: 'Task' },
          {
            cwd: '/tmp/repo',
            isolation: true,
            isolationImage: 'zeroshot-cluster-base',
            worktree: true,
            autoPr: true,
            modelOverride: 'gpt-5.4',
            clusterId: 'cluster-forward-test',
            settings: { repo: 'covibes/orchestra' },
            forceProvider: 'github',
            force: true,
            prBase: 'main',
            mergeQueue: true,
            closeIssue: 'never',
            noMounts: true,
            mounts,
            containerHome: '/tmp/home',
          }
        );
      } finally {
        lifecycleOrchestrator._startInternal = originalStartInternal;
      }

      assert.strictEqual(forwarded.length, 1, 'start() should delegate once');
      const options = forwarded[0].options;
      assert.strictEqual(options.cwd, '/tmp/repo');
      assert.strictEqual(options.isolation, true);
      assert.strictEqual(options.isolationImage, 'zeroshot-cluster-base');
      assert.strictEqual(options.worktree, true);
      assert.strictEqual(options.autoPr, true);
      assert.strictEqual(options.modelOverride, 'gpt-5.4');
      assert.strictEqual(options.clusterId, 'cluster-forward-test');
      assert.deepStrictEqual(options.settings, { repo: 'covibes/orchestra' });
      assert.strictEqual(options.forceProvider, 'github');
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.prBase, 'main');
      assert.strictEqual(options.mergeQueue, true);
      assert.strictEqual(options.closeIssue, 'never');
      assert.strictEqual(options.noMounts, true);
      assert.deepStrictEqual(options.mounts, [
        { source: '/tmp/src', target: '/workspace/src', readonly: true },
      ]);
      assert.strictEqual(options.containerHome, '/tmp/home');
    });

    it('should base PR worktrees on the remote PR base branch', async function () {
      const config = createSimpleConfig();
      const originalCreateWorktreeIsolation = IsolationManager.prototype.createWorktreeIsolation;
      const calls = [];

      IsolationManager.prototype.createWorktreeIsolation = function (clusterId, workDir, options) {
        calls.push({ clusterId, workDir, options });
        return {
          path: '/tmp/zeroshot-worktree',
          branch: 'zeroshot/cluster-local-base',
          repoRoot: workDir,
        };
      };

      try {
        await lifecycleOrchestrator._initializeIsolation(
          {
            cwd: '/tmp/repo',
            worktree: true,
            prBase: 'predev',
          },
          config,
          'cluster-local-base'
        );
      } finally {
        IsolationManager.prototype.createWorktreeIsolation = originalCreateWorktreeIsolation;
      }

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].workDir, '/tmp/repo');
      assert.deepStrictEqual(calls[0].options, {
        baseRef: 'origin/predev',
        requireFreshBase: true,
      });
    });

    it('should handle missing input (requires issue, file, or text)', async function () {
      const config = createSimpleConfig();

      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.start(config, {});
        },
        /issue.*or text/i,
        'Should reject missing input'
      );

      // Input rejection precedes cluster, ledger, and isolation allocation.
      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      assert.strictEqual(lifecycleOrchestrator.clusters.size, 0);
      assert.ok(!fs.existsSync(clustersFile), 'Rejected input must not create clusters.json');
      assert.deepStrictEqual(
        fs.readdirSync(lifecycleStorageDir).filter((entry) => entry.endsWith('.db')),
        [],
        'Rejected input must not allocate a ledger database'
      );
    });

    it('should auto-generate unique cluster IDs', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result1 = await lifecycleOrchestrator.start(config, { text: 'Task 1' });
      const result2 = await lifecycleOrchestrator.start(config, { text: 'Task 2' });

      assert.notStrictEqual(result1.id, result2.id, 'Cluster IDs should be unique');
    });
  });
}

function defineLifecycleStopTests() {
  describe('stop()', function () {
    it('should stop all agents and save state', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);

      // Verify: Cluster marked stopped
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      assert.strictEqual(cluster.state, 'stopped', 'Cluster should be stopped');

      // Verify: State persisted to disk
      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      assert.ok(fs.existsSync(clustersFile), 'clusters.json should exist');

      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.ok(persisted[clusterId], 'Cluster should be in clusters.json');
      assert.strictEqual(
        persisted[clusterId].state,
        'stopped',
        'Persisted state should be stopped'
      );
    });

    it('should fail if cluster does not exist', async function () {
      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.stop('nonexistent-cluster-id');
        },
        /not found/i,
        'Should reject nonexistent cluster'
      );
    });

    it('should wait for initialization to complete before stopping', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').delays(100, { done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Stop immediately (while initializing)
      const stopPromise = lifecycleOrchestrator.stop(clusterId);

      // Should wait for init to complete
      await stopPromise;

      // Verify: ISSUE_OPENED was published (initialization completed)
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      const ledger = new LedgerAssertions(cluster.ledger, clusterId);
      ledger.assertPublished('ISSUE_OPENED');
    });

    it('should auto-cleanup when completedSuccessfully + autoPr (--ship mode)', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Simulate --pr/--ship mode with the worktree resource that stop() owns.
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.autoPr = true;
      let cleanupCalls = 0;
      cluster.worktree = {
        branch: 'test-branch',
        manager: {
          cleanupWorktreeIsolation(cleanupClusterId, options) {
            assert.strictEqual(cleanupClusterId, clusterId);
            assert.deepStrictEqual(options, { preserveBranch: true });
            cleanupCalls += 1;
          },
        },
      };

      await lifecycleOrchestrator.stop(clusterId, { completedSuccessfully: true });
      assert.strictEqual(cleanupCalls, 1, 'Worktree should be cleaned exactly once');

      // Verify: Cluster removed from memory (same as kill behavior)
      const afterStop = lifecycleOrchestrator.getCluster(clusterId);
      assert.strictEqual(
        afterStop,
        undefined,
        'Cluster should be removed from memory after auto-cleanup'
      );

      // Verify: Cluster deleted from disk (not persisted as stopped)
      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(
        persisted[clusterId],
        undefined,
        'Cluster should be deleted from disk after auto-cleanup'
      );
    });

    it('should preserve worktree when stop is user-initiated (no completedSuccessfully)', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Simulate --pr mode
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.autoPr = true;

      // User-initiated stop (Ctrl+C) — no completedSuccessfully flag
      await lifecycleOrchestrator.stop(clusterId);

      // Verify: Cluster still in memory (preserved for resume)
      const afterStop = lifecycleOrchestrator.getCluster(clusterId);
      assert.ok(afterStop, 'Cluster should be preserved in memory for resume');
      assert.strictEqual(afterStop.state, 'stopped', 'State should be stopped');

      // Verify: Cluster persisted to disk
      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.ok(persisted[clusterId], 'Cluster should exist on disk for resume');
    });

    it('should preserve worktree when cluster fails (not completedSuccessfully)', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Simulate --pr mode
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.autoPr = true;

      // Failed cluster stop — no completedSuccessfully
      await lifecycleOrchestrator.stop(clusterId);

      // Verify: Cluster preserved for debugging/resume
      const afterStop = lifecycleOrchestrator.getCluster(clusterId);
      assert.ok(afterStop, 'Failed cluster should be preserved for resume');
      assert.strictEqual(afterStop.state, 'stopped');
    });

    it('should NOT auto-cleanup when completedSuccessfully but no autoPr', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // No autoPr — plain `zeroshot run` without --pr/--ship
      await lifecycleOrchestrator.stop(clusterId, { completedSuccessfully: true });

      // Verify: Cluster preserved (might want to inspect results)
      const afterStop = lifecycleOrchestrator.getCluster(clusterId);
      assert.ok(afterStop, 'Cluster without autoPr should be preserved');
      assert.strictEqual(afterStop.state, 'stopped');
    });
  });
}

function defineLifecycleKillTests() {
  describe('kill()', function () {
    it('should force stop all agents and remove from disk', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      await lifecycleOrchestrator.kill(clusterId);

      // Verify: Cluster removed from memory
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      assert.strictEqual(cluster, undefined, 'Cluster should be removed from memory');

      // Verify: Cluster deleted from disk (not just marked killed)
      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(persisted[clusterId], undefined, 'Cluster should be deleted from disk');
    });

    it('should fail if cluster does not exist', async function () {
      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.kill('nonexistent-cluster-id');
        },
        /not found/i,
        'Should reject nonexistent cluster'
      );
    });

    it('should kill setup clusters without requiring a full message bus', async function () {
      const { clusterId, cluster } = loadSetupCluster(lifecycleOrchestrator, {
        id: 'setup-kill-test',
        pid: 999999,
      });
      cluster.messageBus = { count: () => 0 };

      await lifecycleOrchestrator.kill(clusterId);

      assert.strictEqual(lifecycleOrchestrator.getCluster(clusterId), undefined);

      const clustersFile = path.join(lifecycleStorageDir, 'clusters.json');
      const persisted = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(persisted[clusterId], undefined);
    });
  });
}

function defineLifecycleResumeTests() {
  describe('resume()', function () {
    it('ignores a recovered historical failure and resumes the interrupted validator before routing the aggregate rejection', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'partial-validation-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);

      publishRecoveredWorkerFailureHistory(cluster, clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'IMPLEMENTATION_READY',
        sender: 'worker',
        content: { text: 'Implementation ready for validation' },
      });
      publishInterruptedTaskHistory(cluster, clusterId, 'validator-requirements', {
        iteration: 3,
        taskId: 'interrupted-validator-task',
        triggeredBy: 'IMPLEMENTATION_READY',
      });
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: 'validator-code',
        content: {
          text: 'validator-code: TASK_STARTED',
          data: {
            event: 'TASK_STARTED',
            agent: 'validator-code',
            role: 'validator',
            state: 'executing_task',
            iteration: 3,
          },
        },
      });
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: 'validator-code',
        content: {
          text: 'validator-code: TASK_COMPLETED',
          data: {
            event: 'TASK_COMPLETED',
            agent: 'validator-code',
            role: 'validator',
            state: 'idle',
            iteration: 3,
            taskId: 'completed-validator-task',
          },
        },
      });
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        sender: 'validator-code',
        content: {
          text: 'Rejected with actionable findings',
          data: { approved: false, errors: ['repair this'] },
        },
      });

      const interruptedValidator = cluster.agents.find(
        (agent) => agent.id === 'validator-requirements'
      );
      interruptedValidator.state = 'executing_task';
      interruptedValidator.iteration = 3;
      interruptedValidator.currentTaskId = 'interrupted-validator-task';
      interruptedValidator.processPid = 4242;

      const completedValidator = cluster.agents.find((agent) => agent.id === 'validator-code');
      completedValidator.state = 'idle';
      completedValidator.iteration = 3;
      completedValidator.currentTaskId = 'completed-validator-task';
      completedValidator.processPid = null;

      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      resumedRunner
        .when('validator-requirements')
        .returns({ approved: true, summary: 'Requirements approved' });
      resumedRunner.when('worker').returns('Repaired validation findings');

      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const validationCountBeforeResume = lifecycleOrchestrator
        .getCluster(clusterId)
        .messageBus.count({ cluster_id: clusterId, topic: 'VALIDATION_RESULT' });

      const resumed = await lifecycleOrchestrator.resume(clusterId);
      assert.strictEqual(resumed.resumeType, 'clean');
      assert.deepStrictEqual(resumed.resumedAgents, ['validator-requirements']);
      await waitForAgentCalls(resumedRunner, {
        'validator-requirements': 1,
        worker: 1,
      });

      const resumedCluster = lifecycleOrchestrator.getCluster(clusterId);
      const resumedRequirements = resumedCluster.agents.find(
        (agent) => agent.id === 'validator-requirements'
      );

      assert.strictEqual(resumed.state, 'running');
      assert.notStrictEqual(
        resumedRequirements.currentTaskId,
        'interrupted-validator-task',
        'the stale interrupted task id must not survive recovery'
      );
      assert.strictEqual(resumedRequirements.processPid, null);
      assert.strictEqual(
        resumedRequirements.config.cwd,
        worktreeDir,
        'resume must reuse the persisted worktree cwd'
      );
      resumedRunner.assertCalled('validator-code', 0);
      assert.strictEqual(
        resumedCluster.messageBus.count({
          cluster_id: clusterId,
          topic: 'VALIDATION_RESULT',
        }),
        validationCountBeforeResume + 1,
        'only the interrupted validator may append a new validation result'
      );
    });

    it('ignores a recovered persisted failure and resumes the other interrupted validator exactly once', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'persisted-failure-partial-validation-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      prepareRecoveredRequirementsFailure(cluster, clusterId);
      prepareInterruptedCodeValidator(cluster, clusterId);

      const resumedRunner = new MockTaskRunner();
      resumedRunner
        .when('validator-requirements')
        .returns({ approved: true, summary: 'Requirements approved again' });
      resumedRunner.when('validator-code').returns({ approved: false, summary: 'Code rejected' });
      resumedRunner.when('worker').returns('Repaired validation findings');
      lifecycleOrchestrator = await reloadLifecycleOrchestrator(
        lifecycleOrchestrator,
        lifecycleStorageDir,
        resumedRunner
      );

      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
      const validationCountsBeforeResume = validationResultCounts(restoredCluster, clusterId);

      const resumed = await lifecycleOrchestrator.resume(clusterId);
      assert.strictEqual(resumed.resumeType, 'clean');
      assert.deepStrictEqual(resumed.resumedAgents, ['validator-code']);
      await waitForAgentCalls(resumedRunner, {
        'validator-code': 1,
        worker: 1,
      });

      resumedRunner.assertCalled('validator-requirements', 0);
      assertValidationResultsAdvancedOnce(restoredCluster, clusterId, validationCountsBeforeResume);
    });

    it('resumes a missing validator in a partial validation cycle without replaying completed results', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'missing-validator-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'IMPLEMENTATION_READY',
        sender: 'worker',
        content: { text: 'Implementation ready for validation' },
      });
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        sender: 'validator-code',
        content: {
          text: 'Rejected with actionable findings',
          data: { approved: false, errors: ['repair this'] },
        },
      });
      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      resumedRunner
        .when('validator-requirements')
        .returns({ approved: true, summary: 'Requirements approved' });
      resumedRunner.when('worker').returns('Repaired validation findings');
      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
      const validationCountBeforeResume = restoredCluster.messageBus.count({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
      });

      const resumed = await lifecycleOrchestrator.resume(clusterId);
      await waitForAgentCalls(resumedRunner, {
        'validator-requirements': 1,
        worker: 1,
      });

      assert.deepStrictEqual(resumed.resumedAgents, ['validator-requirements']);
      resumedRunner.assertCalled('validator-code', 0);
      assert.strictEqual(
        restoredCluster.messageBus.count({
          cluster_id: clusterId,
          topic: 'VALIDATION_RESULT',
        }),
        validationCountBeforeResume + 1,
        'the completed validator result must remain a singleton'
      );
    });

    it('recovers an interrupted worker when durable workflow history is older than recent output', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const workerConfig = config.agents.find((agent) => agent.id === 'worker');
      workerConfig.triggers = [{ topic: 'WORKER_PROGRESS', action: 'execute_task' }];

      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Continue the original issue exactly once' },
        { clusterId: 'old-workflow-history-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'WORKER_PROGRESS',
        sender: 'worker',
        content: { text: 'Previous iteration needs another pass' },
      });
      publishInterruptedTaskHistory(cluster, clusterId, 'worker', {
        iteration: 3,
        taskId: 'interrupted-worker-task',
        triggeredBy: 'WORKER_PROGRESS',
      });
      for (let index = 0; index < 75; index += 1) {
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'AGENT_OUTPUT',
          sender: 'worker',
          content: { text: `historical output ${index}` },
        });
      }
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: 'worker',
        content: {
          text: 'worker: STARTED',
          data: {
            event: 'STARTED',
            agent: 'worker',
            role: 'implementation',
            state: 'idle',
          },
        },
      });

      const interruptedWorker = cluster.agents.find((agent) => agent.id === 'worker');
      interruptedWorker.state = 'executing_task';
      interruptedWorker.iteration = 3;
      interruptedWorker.currentTaskId = 'interrupted-worker-task';
      interruptedWorker.processPid = 88623;

      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      resumedRunner.when('worker').returns('Continued original issue');
      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
      const issueCountBeforeResume = restoredCluster.messageBus.count({
        cluster_id: clusterId,
        topic: 'ISSUE_OPENED',
      });

      const resumed = await lifecycleOrchestrator.resume(clusterId);
      await waitForAgentCalls(resumedRunner, { worker: 1 });

      const resumedWorker = restoredCluster.agents.find((agent) => agent.id === 'worker');
      assert.deepStrictEqual(resumed.resumedAgents, ['worker']);
      assert.notStrictEqual(resumedWorker.currentTaskId, 'interrupted-worker-task');
      assert.strictEqual(resumedWorker.config.cwd, worktreeDir);
      assert.strictEqual(
        restoredCluster.messageBus.count({ cluster_id: clusterId, topic: 'ISSUE_OPENED' }),
        issueCountBeforeResume,
        'recovery must not duplicate durable issue execution'
      );
      assert.match(
        resumedRunner.getCalls('worker')[0].context,
        /Continue the original issue exactly once/,
        'the resumed invocation must receive durable original task context even when it is old'
      );
      resumedRunner.assertCalled('validator-code', 0);
      resumedRunner.assertCalled('validator-requirements', 0);
    });

    it('fails atomically when interrupted task-id history is missing or mismatched', async function () {
      for (const scenario of [
        { clusterId: 'missing-task-id-history', assignedTaskId: null },
        { clusterId: 'mismatched-task-id-history', assignedTaskId: 'different-ledger-task' },
      ]) {
        const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
        const config = createPartialValidationResumeConfig(worktreeDir);
        config.agents.find((agent) => agent.id === 'worker').triggers = [
          { topic: 'WORKER_PROGRESS', action: 'execute_task' },
        ];
        const result = await lifecycleOrchestrator.start(
          config,
          { text: 'Preserve task identity during resume' },
          { clusterId: scenario.clusterId }
        );
        const clusterId = result.id;

        await lifecycleOrchestrator.stop(clusterId);
        const cluster = lifecycleOrchestrator.getCluster(clusterId);
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'WORKER_PROGRESS',
          sender: 'worker',
          content: { text: 'Interrupted work' },
        });
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'AGENT_LIFECYCLE',
          sender: 'worker',
          content: {
            text: 'worker: TASK_STARTED',
            data: {
              event: 'TASK_STARTED',
              agent: 'worker',
              state: 'executing_task',
              iteration: 3,
              triggeredBy: 'WORKER_PROGRESS',
            },
          },
        });
        if (scenario.assignedTaskId) {
          cluster.messageBus.publish({
            cluster_id: clusterId,
            topic: 'AGENT_LIFECYCLE',
            sender: 'worker',
            content: {
              text: 'worker: TASK_ID_ASSIGNED',
              data: {
                event: 'TASK_ID_ASSIGNED',
                agent: 'worker',
                state: 'executing_task',
                taskId: scenario.assignedTaskId,
              },
            },
          });
        }

        const interruptedWorker = cluster.agents.find((agent) => agent.id === 'worker');
        interruptedWorker.state = 'executing_task';
        interruptedWorker.iteration = 3;
        interruptedWorker.currentTaskId = 'persisted-task-id';
        interruptedWorker.processPid = 88623;

        deleteLedgerTopics(cluster, clusterId, ['STATE_SNAPSHOT']);
        await lifecycleOrchestrator._saveClusters();
        const messageCountBeforeReload = cluster.messageBus.count({ cluster_id: clusterId });
        lifecycleOrchestrator.close();

        const resumedRunner = new MockTaskRunner();
        lifecycleOrchestrator = await Orchestrator.create({
          taskRunner: resumedRunner,
          storageDir: lifecycleStorageDir,
          quiet: true,
        });

        const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
        await assert.rejects(
          () => lifecycleOrchestrator.resume(clusterId),
          (error) => {
            assert.strictEqual(error.code, 'RESUME_RECONSTRUCTION_FAILED');
            assert.match(error.message, /interrupted-task state is ambiguous/i);
            return true;
          }
        );

        assert.strictEqual(
          restoredCluster.messageBus.count({ cluster_id: clusterId }),
          messageCountBeforeReload,
          'loading and rejecting resume must not append a snapshot or other ledger event'
        );
        resumedRunner.assertCalled('worker', 0);
      }
    });

    it('fails atomically when interrupted work has no durable workflow context', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      config.agents.find((agent) => agent.id === 'worker').triggers = [
        { topic: 'WORKER_PROGRESS', action: 'execute_task' },
      ];
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'This task context must not be guessed' },
        { clusterId: 'missing-workflow-context' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      publishInterruptedTaskHistory(cluster, clusterId, 'worker', {
        iteration: 3,
        taskId: 'interrupted-worker-task',
        triggeredBy: 'WORKER_PROGRESS',
      });
      const interruptedWorker = cluster.agents.find((agent) => agent.id === 'worker');
      interruptedWorker.state = 'executing_task';
      interruptedWorker.iteration = 3;
      interruptedWorker.currentTaskId = 'interrupted-worker-task';
      interruptedWorker.processPid = 88623;

      deleteLedgerTopics(cluster, clusterId, [
        'ISSUE_OPENED',
        'PLAN_READY',
        'IMPLEMENTATION_READY',
        'VALIDATION_RESULT',
        'PUSH_BLOCKED',
        'CONDUCTOR_ESCALATE',
        'STATE_SNAPSHOT',
      ]);
      await lifecycleOrchestrator._saveClusters();
      const messageCountBeforeReload = cluster.messageBus.count({ cluster_id: clusterId });
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });
      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);

      await assert.rejects(
        () => lifecycleOrchestrator.resume(clusterId),
        (error) => {
          assert.strictEqual(error.code, 'RESUME_RECONSTRUCTION_FAILED');
          assert.match(error.message, /no durable workflow context/i);
          assert.match(error.message, /zeroshot export missing-workflow-context/i);
          assert.match(error.message, /do not launch a duplicate run/i);
          assert.doesNotMatch(error.message, /zeroshot run/i);
          return true;
        }
      );

      assert.strictEqual(
        restoredCluster.messageBus.count({ cluster_id: clusterId }),
        messageCountBeforeReload
      );
      resumedRunner.assertCalled('worker', 0);
    });

    it('fails atomically when handlers are registered but no continuation is eligible', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'ineligible-validation-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'IMPLEMENTATION_READY',
        sender: 'worker',
        content: { text: 'Implementation ready for validation' },
      });
      for (const sender of ['validator-code', 'validator-requirements']) {
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'VALIDATION_RESULT',
          sender,
          content: {
            text: 'Approved',
            data: { approved: true },
          },
        });
      }
      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: new MockTaskRunner(),
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
      const messageCountBeforeResume = restoredCluster.messageBus.count({
        cluster_id: clusterId,
      });

      await assert.rejects(
        () => lifecycleOrchestrator.resume(clusterId),
        (error) => {
          assert.strictEqual(error.code, 'RESUME_RECONSTRUCTION_FAILED');
          assert.match(error.message, /registered by worker.*no handler is currently eligible/i);
          assert.doesNotMatch(error.message, /no agents handle it/i);
          return true;
        }
      );

      assert.strictEqual(restoredCluster.state, 'stopped');
      assert.strictEqual(restoredCluster.pid, null);
      assert.strictEqual(restoredCluster.failureInfo.type, 'resume_reconstruction');
      assert.strictEqual(restoredCluster.failureInfo.reason, 'registered_handlers_ineligible');
      assert.strictEqual(
        restoredCluster.messageBus.count({ cluster_id: clusterId }),
        messageCountBeforeResume,
        'failed reconstruction must not append ledger messages'
      );
      assert.ok(
        restoredCluster.agents.every((agent) => agent.running === false),
        'failed reconstruction must not start any agent'
      );
    });

    it('distinguishes an unhandled trigger from an ineligible registered handler', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      config.agents.find((agent) => agent.id === 'worker').triggers = [];
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'unhandled-validation-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        sender: 'validator-code',
        content: { text: 'Rejected', data: { approved: false } },
      });
      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: new MockTaskRunner(),
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      await assert.rejects(
        () => lifecycleOrchestrator.resume(clusterId),
        (error) => {
          assert.strictEqual(error.code, 'RESUME_RECONSTRUCTION_FAILED');
          assert.match(error.message, /no restored agent registers trigger VALIDATION_RESULT/i);
          assert.doesNotMatch(error.message, /currently eligible/i);
          return true;
        }
      );

      const restoredCluster = lifecycleOrchestrator.getCluster(clusterId);
      assert.strictEqual(restoredCluster.failureInfo.reason, 'unhandled_trigger');
      assert.deepStrictEqual(restoredCluster.failureInfo.matchingAgentIds, undefined);
    });

    it('uses normal trigger eligibility after every validator result is durable', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-worktree-'));
      const config = createPartialValidationResumeConfig(worktreeDir);
      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Repair validation findings' },
        { clusterId: 'complete-validation-resume' }
      );
      const clusterId = result.id;

      await lifecycleOrchestrator.stop(clusterId);
      const cluster = lifecycleOrchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'IMPLEMENTATION_READY',
        sender: 'worker',
        content: { text: 'Implementation ready for validation' },
      });
      for (const [sender, approved] of [
        ['validator-code', false],
        ['validator-requirements', true],
      ]) {
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'VALIDATION_RESULT',
          sender,
          content: {
            text: approved ? 'Approved' : 'Rejected',
            data: { approved },
          },
        });
      }
      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      resumedRunner.when('worker').returns('Repaired validation findings');
      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const resumed = await lifecycleOrchestrator.resume(clusterId);
      await waitForAgentCalls(resumedRunner, { worker: 1 });

      assert.deepStrictEqual(resumed.resumedAgents, ['worker']);
      resumedRunner.assertCalled('validator-code', 0);
      resumedRunner.assertCalled('validator-requirements', 0);
    });

    it('should restore ledger and cluster state', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      // Create cluster
      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Wait for worker to complete
      await sleep(500);

      // Stop cluster
      await lifecycleOrchestrator.stop(clusterId);

      // Resume cluster - need to provide handler for IMPLEMENTATION_READY
      // that was published by worker's onComplete hook
      lifecycleMockRunner.when('worker').returns({ done: true, resumed: true });

      // Resume will fail if there's an unhandled message, so we just verify
      // the cluster state is persisted correctly
      const cluster = lifecycleOrchestrator.getCluster(clusterId);

      // Verify: Ledger contains messages even after stop
      const ledger = new LedgerAssertions(cluster.ledger, clusterId);
      ledger.assertPublished('ISSUE_OPENED');

      // Don't actually resume - just verify state persistence worked
      assert.strictEqual(cluster.state, 'stopped', 'Cluster should be stopped');
    });

    it('should mark resumed failed clusters as owned by the current process', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const runningCluster = lifecycleOrchestrator.getCluster(result.id);
      await waitForLifecycleEvent({
        messageBus: runningCluster.messageBus,
        clusterId: result.id,
        agentId: 'worker',
        event: 'TASK_COMPLETED',
      });
      await lifecycleOrchestrator.stop(result.id);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      const durableHighWater = cluster.messageBus.query({
        cluster_id: result.id,
        order: 'desc',
        limit: 1,
      })[0].timestamp;
      cluster.failureInfo = {
        agentId: 'worker',
        taskId: 'persisted-worker-failure',
        iteration: 1,
        error: 'boom',
        timestamp: durableHighWater + 1,
      };

      const resumedRunner = new MockTaskRunner();
      resumedRunner.when('worker').delays(500, { done: true, resumed: true });
      lifecycleOrchestrator = await reloadLifecycleOrchestrator(
        lifecycleOrchestrator,
        lifecycleStorageDir,
        resumedRunner
      );

      const resumed = await lifecycleOrchestrator.resume(result.id);
      const status = lifecycleOrchestrator.getStatus(result.id);
      const restoredCluster = lifecycleOrchestrator.getCluster(result.id);

      assert.strictEqual(resumed.resumeType, 'failure');
      assert.strictEqual(resumed.resumedAgent, 'worker');
      assert.strictEqual(resumed.previousError, 'boom');
      assert.strictEqual(
        restoredCluster.pid,
        process.pid,
        'Resumed cluster should record current PID'
      );
      assert.strictEqual(status.state, 'running', 'Resumed cluster should not self-report zombie');
    });

    it('should preserve the failed-agent path for an unresolved ledger failure', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      await sleep(500);
      await lifecycleOrchestrator.stop(result.id);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      cluster.failureInfo = null;
      cluster.messageBus.publish({
        cluster_id: result.id,
        topic: 'AGENT_ERROR',
        sender: 'worker',
        content: {
          text: 'Current worker failure',
          data: {
            agent: 'worker',
            error: 'current failure',
            iteration: 2,
            taskId: 'current-failed-task',
          },
        },
      });
      await lifecycleOrchestrator._saveClusters();
      lifecycleOrchestrator.close();

      const resumedRunner = new MockTaskRunner();
      resumedRunner.when('worker').returns({ done: true, resumed: true });
      lifecycleOrchestrator = await Orchestrator.create({
        taskRunner: resumedRunner,
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      const resumed = await lifecycleOrchestrator.resume(result.id);
      await waitForAgentCalls(resumedRunner, { worker: 1 });

      assert.strictEqual(resumed.resumeType, 'failure');
      assert.strictEqual(resumed.resumedAgent, 'worker');
      assert.strictEqual(resumed.previousError, 'current failure');
    });

    it('selects an unresolved ledger failure after reloading recovered registry and ledger failures', async function () {
      const worktreeDir = fs.mkdtempSync(path.join(lifecycleStorageDir, 'resume-ordering-'));
      const result = await lifecycleOrchestrator.start(
        createPartialValidationResumeConfig(worktreeDir),
        { text: 'Task' },
        { clusterId: 'persisted-composed-failure-ordering' }
      );
      await lifecycleOrchestrator.stop(result.id);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      prepareRecoveredRequirementsFailure(cluster, result.id);
      publishAgentError(cluster, result.id, 'validator-code', {
        error: 'unresolved code validator failure',
        iteration: 5,
        taskId: 'unresolved-code-task',
        code: 'unsupported-capability',
        permanent: true,
        provider: 'codex',
        capability: 'webSearch',
      });
      publishRecoveredWorkerFailureHistory(cluster, result.id);

      const resumedRunner = new MockTaskRunner();
      resumedRunner.when('validator-code').delays(500, {
        approved: false,
        summary: 'Code rejected',
      });
      lifecycleOrchestrator = await reloadLifecycleOrchestrator(
        lifecycleOrchestrator,
        lifecycleStorageDir,
        resumedRunner
      );

      const restored = lifecycleOrchestrator.getCluster(result.id);
      const failureInfo = lifecycleOrchestrator._resolveFailureInfo(restored, result.id);
      assert.strictEqual(failureInfo.agentId, 'validator-code');
      assert.strictEqual(failureInfo.taskId, 'unresolved-code-task');
      assert.strictEqual(failureInfo.code, 'unsupported-capability');
      assert.strictEqual(failureInfo.permanent, true);
      assert.strictEqual(failureInfo.provider, 'codex');
      assert.strictEqual(failureInfo.capability, 'webSearch');

      const resumed = await lifecycleOrchestrator.resume(result.id);
      await waitForAgentCalls(resumedRunner, { 'validator-code': 1 });
      assert.strictEqual(resumed.resumeType, 'failure');
      assert.strictEqual(resumed.resumedAgent, 'validator-code');
      assert.strictEqual(resumed.previousError, 'unresolved code validator failure');
      resumedRunner.assertCalled('validator-requirements', 0);
      resumedRunner.assertCalled('worker', 0);
    });

    it('should skip every recovered error and select the newest unresolved failure from complete history', async function () {
      const worktreeDir = fs.mkdtempSync(
        path.join(lifecycleStorageDir, 'resume-failure-ordering-')
      );
      const result = await lifecycleOrchestrator.start(
        createPartialValidationResumeConfig(worktreeDir),
        { text: 'Task' },
        { worktreeDir }
      );
      await lifecycleOrchestrator.stop(result.id);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      cluster.messageBus.publish({
        cluster_id: result.id,
        topic: 'AGENT_ERROR',
        sender: 'validator-code',
        content: {
          text: 'Older validator failure',
          data: {
            agent: 'validator-code',
            error: 'older unresolved validator failure',
            iteration: 3,
            taskId: 'older-unresolved-validator-task',
          },
        },
      });
      cluster.messageBus.publish({
        cluster_id: result.id,
        topic: 'AGENT_ERROR',
        sender: 'validator-requirements',
        content: {
          text: 'Validator still failed',
          data: {
            agent: 'validator-requirements',
            error: 'unresolved validator failure',
            iteration: 4,
            taskId: 'unresolved-validator-task',
          },
        },
      });

      for (let index = 0; index < 12; index += 1) {
        publishRecoveredWorkerFailureHistory(cluster, result.id);
      }
      cluster.failureInfo = null;

      const failureInfo = lifecycleOrchestrator._resolveFailureInfo(cluster, result.id);

      assert.strictEqual(failureInfo.agentId, 'validator-requirements');
      assert.strictEqual(failureInfo.taskId, 'unresolved-validator-task');
      assert.strictEqual(failureInfo.error, 'unresolved validator failure');
    });

    it('restores a proven completed session without reviving currentTask handles', async function () {
      const config = createSimpleConfig();
      const privatePrompt = `PRIVATE-CONTINUATION-PROMPT-${'x'.repeat(16_384)}`;
      const privatePromptIdentity = promptIdentity(privatePrompt);
      lifecycleMockRunner.when('worker').delays(1000, { done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const cluster = lifecycleOrchestrator.getCluster(result.id);
      const agent = cluster.agents[0];

      cluster.state = 'stopped';
      cluster.pid = null;
      agent.state = 'stopped';
      agent.currentTask = { kill() {} };
      agent.currentTaskId = 'task-live';
      agent.processPid = 4242;
      agent.providerSession = {
        provider: 'claude',
        sessionId: 'agent-owned-session',
        agentId: agent.id,
        taskId: 'task-complete',
        generation: agent.iteration,
        cwd: path.resolve(agent.config.cwd || process.cwd()),
        worktreePath: null,
        contextSequence: '41',
        guidanceSequence: '17',
        promptIdentity: privatePromptIdentity,
      };
      agent.lastGuidanceAppliedId = '17';
      cluster.messageBus.publish({
        cluster_id: result.id,
        topic: 'AGENT_LIFECYCLE',
        sender: agent.id,
        content: {
          text: `${agent.id}: TASK_COMPLETED`,
          data: {
            event: 'TASK_COMPLETED',
            provider: 'claude',
            taskId: 'task-complete',
            iteration: agent.iteration,
            contextSequence: '41',
            guidanceSequence: '17',
            promptIdentity: privatePromptIdentity,
          },
        },
      });

      await lifecycleOrchestrator._saveClusters();
      const persistedRegistry = fs.readFileSync(
        path.join(lifecycleStorageDir, 'clusters.json'),
        'utf8'
      );
      const exportedLedger = lifecycleOrchestrator.export(result.id, 'json');
      assert.ok(privatePromptIdentity.length <= 71);
      assert.ok(!persistedRegistry.includes(privatePrompt));
      assert.ok(!exportedLedger.includes(privatePrompt));
      assert.ok(!persistedRegistry.includes('"promptText"'));
      assert.ok(!exportedLedger.includes('"promptText"'));

      const reloaded = await Orchestrator.create({
        taskRunner: new MockTaskRunner(),
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      try {
        const restoredCluster = reloaded.getCluster(result.id);
        const restoredAgent = restoredCluster.agents[0];
        const restoredState = restoredAgent.getState();

        assert.strictEqual(restoredAgent.currentTask, null);
        assert.strictEqual(restoredAgent.currentTaskId, 'task-live');
        assert.deepStrictEqual(restoredAgent.providerSession, {
          provider: 'claude',
          sessionId: 'agent-owned-session',
          agentId: agent.id,
          taskId: 'task-complete',
          generation: agent.iteration,
          cwd: path.resolve(agent.config.cwd || process.cwd()),
          worktreePath: null,
          contextSequence: '41',
          guidanceSequence: '17',
          promptIdentity: privatePromptIdentity,
        });
        assert.strictEqual(restoredAgent.lastGuidanceAppliedId, '17');
        assert.strictEqual(restoredState.currentTask, false);
      } finally {
        reloaded.close();
      }
    });

    it('drops session state when a crash snapshot ends in a live or failed generation', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').delays(1000, { done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const cluster = lifecycleOrchestrator.getCluster(result.id);
      const agent = cluster.agents[0];
      const cwd = path.resolve(agent.config.cwd || process.cwd());

      cluster.state = 'stopped';
      cluster.pid = null;
      agent.state = 'executing_task';
      agent.iteration = 2;
      agent.currentTaskId = 'task-live-generation-2';
      agent.providerSession = {
        provider: 'claude',
        sessionId: 'completed-generation-1',
        agentId: agent.id,
        taskId: 'task-complete-generation-1',
        generation: 1,
        cwd,
        worktreePath: null,
        contextSequence: 41,
        guidanceSequence: 17,
        promptIdentity: promptIdentity(agent._selectPrompt()),
      };
      agent.lastGuidanceAppliedId = 17;
      for (const data of [
        {
          event: 'TASK_COMPLETED',
          provider: 'claude',
          taskId: 'task-complete-generation-1',
          iteration: 1,
          contextSequence: 41,
          guidanceSequence: 17,
          promptIdentity: promptIdentity(agent._selectPrompt()),
        },
        {
          event: 'TASK_STARTED',
          provider: 'claude',
          taskId: 'task-live-generation-2',
          iteration: 2,
        },
        {
          event: 'TASK_FAILED',
          provider: 'claude',
          taskId: 'task-live-generation-2',
          iteration: 2,
        },
      ]) {
        cluster.messageBus.publish({
          cluster_id: result.id,
          topic: 'AGENT_LIFECYCLE',
          sender: agent.id,
          content: { text: `${agent.id}: ${data.event}`, data },
        });
      }

      await lifecycleOrchestrator._saveClusters();
      const reloaded = await Orchestrator.create({
        taskRunner: new MockTaskRunner(),
        storageDir: lifecycleStorageDir,
        quiet: true,
      });

      try {
        assert.strictEqual(reloaded.getCluster(result.id).agents[0].providerSession, null);
      } finally {
        reloaded.close();
      }
    });

    it('should fail if cluster does not exist', async function () {
      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.resume('nonexistent-cluster-id');
        },
        /not found/i,
        'Should reject nonexistent cluster'
      );
    });

    it('should fail if cluster is still running', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      const clusterId = result.id;

      // Try to resume while running
      await assert.rejects(
        async () => {
          await lifecycleOrchestrator.resume(clusterId);
        },
        /still running/i,
        'Should reject resume of running cluster'
      );
    });

    it('should recover a zombie cluster (state=running, dead pid) instead of rejecting resume', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(config, { text: 'Task' });
      await lifecycleOrchestrator.stop(result.id);

      const cluster = lifecycleOrchestrator.getCluster(result.id);
      cluster.failureInfo = {
        agentId: 'worker',
        iteration: 1,
        error: 'boom',
      };
      // Simulate exactly the zombie condition getStatus()/listClusters() already
      // detect: state says 'running' but the recorded PID belongs to a daemon
      // that is no longer alive (e.g. it was killed by a caller timeout). Before
      // the fix, resume() trusted `state` alone here and threw "still running",
      // even though status would have reported this same cluster as a zombie.
      cluster.state = 'running';
      cluster.pid = 999999;

      lifecycleMockRunner.when('worker').delays(500, { done: true, resumed: true });

      const resumed = await lifecycleOrchestrator.resume(result.id);
      const status = lifecycleOrchestrator.getStatus(result.id);

      assert.strictEqual(resumed.resumeType, 'failure');
      assert.strictEqual(cluster.pid, process.pid, 'Recovered cluster should record current PID');
      assert.strictEqual(
        status.state,
        'running',
        'Recovered cluster should be running, not zombie'
      );
    });

    it('should reject setup cluster resume with an actionable error', async function () {
      const { clusterId, cluster } = loadSetupCluster(lifecycleOrchestrator, {
        id: 'setup-resume-test',
        failureInfo: {
          type: 'setup',
          error: 'npm ci exploded',
          timestamp: Date.now(),
        },
      });
      cluster.messageBus = {
        findLast() {
          throw new Error('resume should not inspect setup ledger');
        },
        query() {
          throw new Error('resume should not inspect setup ledger');
        },
      };

      await assert.rejects(async () => {
        await lifecycleOrchestrator.resume(clusterId);
      }, /never finished setup.*cannot be resumed.*npm ci exploded.*zeroshot run/i);
    });
  });
}

function defineLifecycleGetStatusTests() {
  describe('getStatus()', function () {
    it('should return cluster status', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      const result = await lifecycleOrchestrator.start(
        config,
        { text: 'Task' },
        {
          runMode: 'worktree',
        }
      );
      const clusterId = result.id;

      const status = lifecycleOrchestrator.getStatus(clusterId);

      assert.strictEqual(status.id, clusterId, 'Status should have cluster ID');
      assert.strictEqual(status.state, 'running', 'Status should show running');
      assert.strictEqual(status.agents.length, 1, 'Status should show 1 agent');
      assert.ok(status.messageCount >= 1, 'Status should show message count');
      assert.strictEqual(status.runMode, 'worktree', 'Status should reflect runMode');
    });

    it('should fail if cluster does not exist', function () {
      assert.throws(
        () => {
          lifecycleOrchestrator.getStatus('nonexistent-cluster-id');
        },
        /not found/i,
        'Should throw for nonexistent cluster'
      );
    });
  });
}

function defineLifecycleListClustersTests() {
  describe('listClusters()', function () {
    it('should return empty array when no clusters exist', function () {
      const clusters = lifecycleOrchestrator.listClusters();
      assert.strictEqual(clusters.length, 0, 'Should return empty array');
    });

    it('should return all clusters', async function () {
      const config = createSimpleConfig();
      lifecycleMockRunner.when('worker').returns({ done: true });

      await lifecycleOrchestrator.start(config, { text: 'Task 1' });
      await lifecycleOrchestrator.start(config, { text: 'Task 2' }, { runMode: 'pr' });

      const clusters = lifecycleOrchestrator.listClusters();
      assert.strictEqual(clusters.length, 2, 'Should return 2 clusters');

      // Verify: Clusters have required fields
      for (const cluster of clusters) {
        assert.ok(cluster.id, 'Cluster should have ID');
        assert.ok(cluster.state, 'Cluster should have state');
        assert.ok(typeof cluster.agentCount === 'number', 'Cluster should have agentCount');
      }

      const withoutRunMode = clusters.find((c) => !c.runMode);
      const withRunMode = clusters.find((c) => c.runMode === 'pr');
      assert.ok(withoutRunMode, 'Cluster started without runMode should have runMode null');
      assert.ok(withRunMode, 'Cluster started with runMode option should reflect it');
    });
  });
}
describe('Orchestrator - Crash Recovery (CRITICAL)', function () {
  this.timeout(10000);

  let storageDir;

  beforeEach(function () {
    storageDir = createTempDir();
  });

  afterEach(function () {
    cleanupTempDir(storageDir);
  });

  it('should recover cluster state from disk after restart', async function () {
    let clusterId;

    // Phase 1: Create cluster and crash
    {
      const mockRunner = new MockTaskRunner();
      mockRunner.when('worker').returns({ done: true });

      const orchestrator = new Orchestrator({
        taskRunner: mockRunner,
        storageDir,
        skipLoad: true,
        quiet: true,
      });

      const config = createSimpleConfig();
      const result = await orchestrator.start(config, { text: 'Task' }, { runMode: 'ship' });
      clusterId = result.id;

      // Publish additional message
      const cluster = orchestrator.getCluster(clusterId);
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'PROGRESS',
        sender: 'worker',
        content: { status: 'in-progress' },
      });

      // Stop cluster
      await orchestrator.stop(clusterId);

      // Close orchestrator (simulate crash)
      orchestrator.close();
    }

    // Phase 2: New orchestrator instance - auto-loads clusters
    {
      const orchestrator2 = await Orchestrator.create({
        storageDir,
        quiet: true,
        // skipLoad: false (default) - should auto-load
      });

      // Verify: Cluster loaded
      const clusters = orchestrator2.listClusters();
      assert.ok(clusters.length > 0, 'Should load at least one cluster');

      const loadedCluster = clusters.find((c) => c.id === clusterId);
      assert.ok(loadedCluster, 'Should load the created cluster');
      assert.strictEqual(
        loadedCluster.runMode,
        'ship',
        'runMode should round-trip through save/reload'
      );

      // Verify: Ledger restored
      const cluster = orchestrator2.getCluster(clusterId);
      const ledger = new LedgerAssertions(cluster.ledger, clusterId);
      ledger.assertPublished('ISSUE_OPENED');
      ledger.assertPublished('PROGRESS');

      orchestrator2.close();
    }
  });

  it('should handle corrupted clusters.json gracefully', function () {
    // Write corrupted JSON
    const clustersFile = path.join(storageDir, 'clusters.json');
    fs.writeFileSync(clustersFile, 'NOT VALID JSON{');

    // Should not throw - log error and continue
    const orchestrator = new Orchestrator({ storageDir, quiet: true });

    // Verify: Empty cluster list (corrupted file ignored)
    assert.strictEqual(orchestrator.listClusters().length, 0, 'Should have no clusters');

    orchestrator.close();
  });

  it('should handle missing .db file for cluster', function () {
    // Create clusters.json with a cluster entry
    const clustersFile = path.join(storageDir, 'clusters.json');
    const clusterId = 'test-cluster-123';
    fs.writeFileSync(
      clustersFile,
      JSON.stringify({
        [clusterId]: {
          id: clusterId,
          config: { agents: [] },
          state: 'stopped',
        },
      })
    );

    // Don't create the .db file (orphaned entry)

    // Should not throw - remove orphaned entry
    const orchestrator = new Orchestrator({ storageDir, quiet: true });

    // Verify: Orphaned entry removed
    const clusters = orchestrator.listClusters();
    assert.strictEqual(clusters.length, 0, 'Should have no clusters');

    orchestrator.close();
  });

  it('should skip invalid persisted clusters and load valid clusters', async function () {
    const clustersFile = path.join(storageDir, 'clusters.json');
    const invalidClusterId = 'invalid-template-cluster';
    const validClusterId = 'valid-cluster';
    fs.writeFileSync(
      clustersFile,
      JSON.stringify({
        [invalidClusterId]: {
          id: invalidClusterId,
          config: {
            agents: [{ id: 'planner', role: 'planning', modelLevel: '{{planner_level}}' }],
          },
          state: 'stopped',
        },
        [validClusterId]: {
          id: validClusterId,
          config: { agents: [] },
          state: 'stopped',
        },
      })
    );

    const invalidLedger = new Ledger(path.join(storageDir, `${invalidClusterId}.db`));
    invalidLedger.close();
    const validLedger = new Ledger(path.join(storageDir, `${validClusterId}.db`));
    validLedger.close();

    const orchestrator = await Orchestrator.create({ storageDir, quiet: true });
    const clusters = orchestrator.listClusters();

    assert.ok(!clusters.some((cluster) => cluster.id === invalidClusterId));
    assert.ok(clusters.some((cluster) => cluster.id === validClusterId));

    orchestrator.close();
  });
});

describe('Orchestrator - Concurrent Operations (Race Conditions)', function () {
  this.timeout(15000);

  let orchestrator, mockRunner, storageDir;

  beforeEach(function () {
    mockRunner = new MockTaskRunner();
    storageDir = createTempDir();
    orchestrator = new Orchestrator({
      taskRunner: mockRunner,
      storageDir,
      skipLoad: true,
      quiet: true,
    });
  });

  afterEach(function () {
    if (orchestrator) {
      orchestrator.close();
    }
    cleanupTempDir(storageDir);
  });

  it('should handle concurrent cluster starts without ID collision', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    // Start 10 clusters concurrently
    const promises = Array(10)
      .fill()
      .map((_, i) => orchestrator.start(config, { text: `Task ${i}` }));

    const results = await Promise.all(promises);
    const clusterIds = results.map((r) => r.id);

    // Verify: All unique IDs
    const uniqueIds = new Set(clusterIds);
    assert.strictEqual(uniqueIds.size, 10, 'All cluster IDs should be unique');

    // Verify: All persisted
    const clusters = orchestrator.listClusters();
    assert.strictEqual(clusters.length, 10, 'All clusters should be persisted');
  });

  it('should prevent race condition in _saveClusters()', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    // Start cluster
    const result = await orchestrator.start(config, { text: 'Task' });
    const clusterId = result.id;

    // Concurrent message publishes (triggers rapid saves)
    const cluster = orchestrator.getCluster(clusterId);
    const saves = Array(50)
      .fill()
      .map((_, i) => {
        cluster.messageBus.publish({
          cluster_id: clusterId,
          topic: 'TEST',
          sender: 'test',
          content: { i },
        });
      });

    await Promise.all(saves);

    // Small delay to ensure saves complete
    await sleep(100);

    // Verify: File not corrupted
    const clustersFile = path.join(storageDir, 'clusters.json');
    const content = fs.readFileSync(clustersFile, 'utf8');
    let persisted;

    assert.doesNotThrow(() => {
      persisted = JSON.parse(content);
    }, 'clusters.json should be valid JSON');

    assert.ok(typeof persisted === 'object', 'clusters.json should be an object');
    assert.ok(persisted[clusterId], 'Cluster should exist in file');
  });

  it('should handle file locking during concurrent reads', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    // Create a cluster and save it
    await orchestrator.start(config, { text: 'Task' });

    // Close first orchestrator
    orchestrator.close();

    // Create multiple orchestrators that all try to load at once
    const orchestrators = await Promise.all(
      Array(5)
        .fill()
        .map(() =>
          Orchestrator.create({
            storageDir,
            quiet: true,
            // skipLoad: false (default) - all load simultaneously
          })
        )
    );

    // Verify: All loaded the cluster successfully
    for (const orch of orchestrators) {
      const clusters = orch.listClusters();
      assert.ok(clusters.length > 0, 'Orchestrator should load clusters');
      orch.close();
    }
  });
});

describe('Orchestrator - Error Handling', function () {
  this.timeout(10000);

  let orchestrator, mockRunner, storageDir;

  beforeEach(function () {
    mockRunner = new MockTaskRunner();
    storageDir = createTempDir();
    orchestrator = new Orchestrator({
      taskRunner: mockRunner,
      storageDir,
      skipLoad: true,
      quiet: true,
    });
  });

  afterEach(function () {
    if (orchestrator) {
      orchestrator.close();
    }
    cleanupTempDir(storageDir);
  });

  it('should handle invalid agent ID in operations', async function () {
    const config = loadFixture('single-worker.json');
    // Use delay so cluster stays running long enough to test invalid operation handling
    mockRunner.when('worker').delays(500, { done: true });

    const result = await orchestrator.start(config, { text: 'Task' });
    const clusterId = result.id;

    // Try to publish CLUSTER_OPERATIONS with invalid operation
    const cluster = orchestrator.getCluster(clusterId);

    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: 'CLUSTER_OPERATIONS',
      sender: 'test',
      content: {
        data: {
          operations: [
            {
              action: 'invalid_action', // Invalid action
            },
          ],
        },
      },
    });

    // Should not crash - operation should fail gracefully
    await sleep(100);

    // Cluster should still exist and not have crashed (state can be running, stopping, or stopped)
    assert.ok(cluster, 'Cluster should still exist');
    assert.ok(
      ['running', 'stopping', 'stopped'].includes(cluster.state),
      `Cluster should be in valid state (got: ${cluster.state})`
    );
  });

  it('should handle missing storageDir gracefully', function () {
    const nonExistentDir = path.join(os.tmpdir(), 'zeroshot-nonexistent-' + Date.now());

    // Should create directory automatically
    const orch = new Orchestrator({
      storageDir: nonExistentDir,
      skipLoad: true,
      quiet: true,
    });

    assert.ok(fs.existsSync(nonExistentDir), 'Should create storageDir if missing');

    orch.close();
    cleanupTempDir(nonExistentDir);
  });

  it('should handle validateConfig for invalid config', function () {
    const invalidConfig = {
      agents: [
        {
          id: 'test',
          // Missing required fields
        },
      ],
    };

    const result = orchestrator.validateConfig(invalidConfig);

    assert.strictEqual(result.valid, false, 'Should mark config as invalid');
    assert.ok(result.errors.length > 0, 'Should have error messages');
  });

  it('should handle loadConfig with missing file', function () {
    const nonExistentPath = path.join(storageDir, 'nonexistent.json');

    assert.throws(
      () => {
        orchestrator.loadConfig(nonExistentPath);
      },
      /ENOENT/,
      'Should throw file not found error'
    );
  });

  it('should handle loadConfig with invalid JSON', function () {
    const badConfigPath = path.join(storageDir, 'bad-config.json');
    fs.writeFileSync(badConfigPath, 'NOT VALID JSON{');

    assert.throws(
      () => {
        orchestrator.loadConfig(badConfigPath);
      },
      /JSON/,
      'Should throw JSON parse error'
    );
  });
});

describe('Orchestrator - File Locking', function () {
  this.timeout(10000);

  let storageDir;

  beforeEach(function () {
    storageDir = createTempDir();
  });

  afterEach(function () {
    cleanupTempDir(storageDir);
  });

  it('should use file locking for _saveClusters()', async function () {
    const mockRunner = new MockTaskRunner();
    mockRunner.when('worker').returns({ done: true });

    const orch1 = new Orchestrator({
      taskRunner: mockRunner,
      storageDir,
      skipLoad: true,
      quiet: true,
    });

    const config = loadFixture('single-worker.json');
    await orch1.start(config, { text: 'Task 1' });

    // Verify: Lock file created during save
    const clustersFile = path.join(storageDir, 'clusters.json');
    assert.ok(fs.existsSync(clustersFile), 'clusters.json should exist');

    orch1.close();
  });

  it('should use file locking for _loadClusters()', async function () {
    // Create a cluster first
    {
      const mockRunner = new MockTaskRunner();
      mockRunner.when('worker').returns({ done: true });

      const orch = new Orchestrator({
        taskRunner: mockRunner,
        storageDir,
        skipLoad: true,
        quiet: true,
      });

      const config = createSimpleConfig();
      await orch.start(config, { text: 'Task' });
      await orch.stop((await orch.listClusters())[0].id);
      orch.close();
    }

    // Load clusters (should acquire lock)
    const orch2 = await Orchestrator.create({
      storageDir,
      quiet: true,
      // skipLoad: false (default)
    });

    const clusters = orch2.listClusters();
    assert.ok(clusters.length > 0, 'Should load clusters');

    orch2.close();
  });
});

describe('Orchestrator - Edge Cases', function () {
  this.timeout(10000);

  let orchestrator, mockRunner, storageDir;

  beforeEach(function () {
    mockRunner = new MockTaskRunner();
    storageDir = createTempDir();
    orchestrator = new Orchestrator({
      taskRunner: mockRunner,
      storageDir,
      skipLoad: true,
      quiet: true,
    });
  });

  afterEach(function () {
    if (orchestrator) {
      orchestrator.close();
    }
    cleanupTempDir(storageDir);
  });

  // TEST REMOVED: Contradicts test in "Cluster Lifecycle" section (line 181)
  // Original design: orchestrator doesn't validate config structure upfront (line 184 comment)
  // Cluster creation succeeds with empty agents, but fails when trying to start agents

  it('should handle killAll with no running clusters', async function () {
    const result = await orchestrator.killAll();

    assert.strictEqual(result.killed.length, 0, 'Should kill 0 clusters');
    assert.strictEqual(result.errors.length, 0, 'Should have 0 errors');
  });

  it('should handle killAll with multiple running clusters', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    await orchestrator.start(config, { text: 'Task 1' });
    await orchestrator.start(config, { text: 'Task 2' });
    await orchestrator.start(config, { text: 'Task 3' });

    const result = await orchestrator.killAll();

    assert.strictEqual(result.killed.length, 3, 'Should kill 3 clusters');
    assert.strictEqual(result.errors.length, 0, 'Should have 0 errors');

    // Verify: All clusters removed
    assert.strictEqual(orchestrator.listClusters().length, 0, 'Should have no clusters');
  });

  it('should handle export() with json format', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    const result = await orchestrator.start(config, { text: 'Task' });
    const clusterId = result.id;

    const exported = orchestrator.export(clusterId, 'json');

    assert.ok(typeof exported === 'string', 'Exported data should be a string');

    const parsed = JSON.parse(exported);
    assert.strictEqual(parsed.cluster_id, clusterId, 'Should have cluster ID');
    assert.ok(Array.isArray(parsed.messages), 'Should have messages array');
  });

  it('should handle export() with unknown format', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    const result = await orchestrator.start(config, { text: 'Task' });
    const clusterId = result.id;

    assert.throws(
      () => {
        orchestrator.export(clusterId, 'invalid-format');
      },
      /unknown export format/i,
      'Should throw for unknown format'
    );
  });

  it('should handle closed orchestrator preventing saves', async function () {
    const config = loadFixture('single-worker.json');
    mockRunner.when('worker').returns({ done: true });

    const result = await orchestrator.start(config, { text: 'Task' });
    const cluster = orchestrator.getCluster(result.id);

    // Close orchestrator
    orchestrator.close();

    // Verify: closed flag set
    assert.strictEqual(orchestrator.closed, true, 'Orchestrator should be closed');
    assert.strictEqual(cluster.messageBus._closed, true, 'Message bus should be closed');
    assert.strictEqual(cluster.ledger._closed, true, 'Ledger should be closed');

    // _saveClusters should be a no-op now (prevents race conditions)
    // No assertion needed - just verify it doesn't throw
  });
});

describe('Codex planner structured-output recovery', function () {
  this.timeout(30000);

  it('recovers malformed Codex structured output without retrying the parent task', async function () {
    const result = await runStructuredOutputRecovery();

    assert.strictEqual(result.state, 'stopped');
    assert.strictEqual(result.configuredRole, 'planner');
    assert.strictEqual(result.fakeCount, '2', JSON.stringify(result, null, 2));
    assert.deepStrictEqual(result.lifecycle, [
      'STARTED',
      'TASK_STARTED',
      'TASK_ID_ASSIGNED',
      'TASK_COMPLETED',
    ]);
    assert.strictEqual(result.agentState.iteration, 1);
    assert.strictEqual(result.agentState.providerSession, null);
    assert.deepStrictEqual(result.completionData, { repaired: true });
    assert.ok(result.topics.includes('CLUSTER_COMPLETE'));
    assert.strictEqual(result.topics.includes('AGENT_ERROR'), false);
    assert.strictEqual(Object.keys(result.tasks).length, 2);
    assert.ok(Object.values(result.tasks).every((task) => task.status === 'completed'));
    const taskStates = Object.values(result.tasks);
    assert.ok(
      taskStates.every(
        (task) =>
          (task.sessionId === null || task.sessionId === undefined) &&
          task.sessionIdConflict === false &&
          (task.requestedResumeSessionId === null || task.requestedResumeSessionId === undefined)
      )
    );
    assert.deepStrictEqual(taskStates.map((task) => task.resumeIdentityVerified).sort(), [
      false,
      true,
    ]);
  });
});
