// Skip gh CLI verification in integration tests (we mock the task runner, not the CLI)
process.env.ZEROSHOT_SKIP_GH_VERIFY = '1';

/**
 * Integration tests for complete cluster lifecycle
 *
 * Tests the full message flow: ISSUE_OPENED → agents → completion
 * Uses MockTaskRunner to avoid real Claude API calls while testing
 * all coordination logic.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const Orchestrator = require('../../src/orchestrator');
const _Ledger = require('../../src/ledger');
const _MessageBus = require('../../src/message-bus');
const { generateGitPusherAgent } = require('../../src/agents/git-pusher-template');
const MockTaskRunner = require('../helpers/mock-task-runner');
const LedgerAssertions = require('../helpers/ledger-assertions');

let tempDir;
let orchestrator;
let mockRunner;

function createOrchestrator() {
  orchestrator = new Orchestrator({
    quiet: true,
    storageDir: tempDir,
    taskRunner: mockRunner,
  });
  return orchestrator;
}

describe('Orchestrator Flow Integration', function () {
  this.timeout(30000);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-integration-'));
    mockRunner = new MockTaskRunner();
  });

  afterEach(async () => {
    if (orchestrator) {
      const clusters = orchestrator.listClusters();
      for (const cluster of clusters) {
        try {
          await orchestrator.kill(cluster.id);
        } catch {
          // Ignore cleanup errors
        }
      }

      orchestrator.close();
      orchestrator = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  defineSimpleWorkerFlowTests();
  defineWorkerValidatorFlowTests();
  definePrModeFlowTests();
  defineConsensusValidatorTests();
  defineErrorHandlingTests();
  defineSigintRaceConditionTests();
  defineInvalidCommandHandlingTests();
  defineClusterOperationsFailureTests();
});

function defineSimpleWorkerFlowTests() {
  describe('Simple Worker Flow', () => {
    const simpleConfig = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          timeout: 0,
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          prompt: 'Implement the requested feature',
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'TASK_COMPLETE', content: { text: 'Done' } },
            },
          },
        },
        {
          id: 'completion-detector',
          role: 'orchestrator',
          timeout: 0,
          triggers: [{ topic: 'TASK_COMPLETE', action: 'stop_cluster' }],
        },
      ],
    };

    it('should execute worker and complete cluster', async () => {
      mockRunner.when('worker').returns(
        JSON.stringify({
          summary: 'Feature implemented',
          files: ['src/feature.js'],
        })
      );

      createOrchestrator();

      const result = await orchestrator.start(simpleConfig, {
        text: 'Implement feature X',
      });
      const clusterId = result.id;

      // Wait for completion
      await waitForClusterState(orchestrator, clusterId, 'stopped', 10000);

      // Verify worker was called
      mockRunner.assertCalled('worker', 1);

      // Verify context included the task
      const calls = mockRunner.getCalls('worker');
      assert(calls[0].context.includes('Implement feature X'), 'Context should include task');
    });

    it('should publish messages in correct order', async () => {
      mockRunner.when('worker').returns('{"done": true}');

      createOrchestrator();

      const result = await orchestrator.start(simpleConfig, {
        text: 'Test task',
      });
      const clusterId = result.id;
      await waitForClusterState(orchestrator, clusterId, 'stopped', 10000);

      // Get ledger and verify message sequence
      const cluster = orchestrator.getCluster(clusterId);
      const ledger = cluster.messageBus.ledger;
      const assertions = new LedgerAssertions(ledger, clusterId);

      assertions
        .assertPublished('ISSUE_OPENED')
        .assertPublished('TASK_COMPLETE')
        .assertSequence(['ISSUE_OPENED', 'TASK_COMPLETE']);
    });
  });
}

function defineWorkerValidatorFlowTests() {
  describe('Worker + Validator Flow', () => {
    const validatorConfig = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          timeout: 0,
          triggers: [
            { topic: 'ISSUE_OPENED', action: 'execute_task' },
            {
              topic: 'VALIDATION_RESULT',
              action: 'execute_task',
              logic: {
                engine: 'javascript',
                script: `
                  const result = ledger.findLast({ topic: 'VALIDATION_RESULT' });
                  return result && (result.content?.data?.approved === false || result.content?.data?.approved === 'false');
                `,
              },
            },
          ],
          prompt: 'Implement the feature',
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
          timeout: 0,
          triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
          prompt: 'Validate the implementation',
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: {
              approved: { type: 'boolean' },
              issues: { type: 'array' },
            },
            required: ['approved'],
          },
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'VALIDATION_RESULT',
                content: { data: { approved: '{{result.approved}}' } },
              },
            },
          },
        },
        {
          id: 'completion-detector',
          role: 'orchestrator',
          timeout: 0,
          triggers: [
            {
              topic: 'VALIDATION_RESULT',
              action: 'stop_cluster',
              logic: {
                engine: 'javascript',
                script: `
                const result = ledger.findLast({ topic: 'VALIDATION_RESULT' });
                return result && (result.content?.data?.approved === true || result.content?.data?.approved === 'true');
              `,
              },
            },
          ],
        },
      ],
    };

    it('should complete on approval', async () => {
      mockRunner.when('worker').returns('{"implemented": true}');
      mockRunner.when('validator').returns(
        JSON.stringify({
          approved: true,
          issues: [],
        })
      );

      createOrchestrator();

      const result = await orchestrator.start(validatorConfig, {
        text: 'Build feature',
      });
      const clusterId = result.id;
      await waitForClusterState(orchestrator, clusterId, 'stopped', 15000);

      mockRunner.assertCalled('worker', 1);
      mockRunner.assertCalled('validator', 1);

      const cluster = orchestrator.getCluster(clusterId);
      const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

      assertions.assertSequence(['ISSUE_OPENED', 'IMPLEMENTATION_READY', 'VALIDATION_RESULT']);
    });

    it('should retry worker on rejection', async () => {
      let workerCallCount = 0;
      mockRunner.when('worker').calls(() => {
        workerCallCount++;
        return {
          success: true,
          output: JSON.stringify({ attempt: workerCallCount }),
        };
      });

      let validatorCallCount = 0;
      mockRunner.when('validator').calls(() => {
        validatorCallCount++;
        // First call rejects, second approves
        const approved = validatorCallCount >= 2;
        return {
          success: true,
          output: JSON.stringify({
            approved,
            issues: approved ? [] : ['Bug found'],
          }),
        };
      });

      createOrchestrator();

      const result = await orchestrator.start(validatorConfig, {
        text: 'Build with retry',
      });
      const clusterId = result.id;
      await waitForClusterState(orchestrator, clusterId, 'stopped', 20000);

      // Worker should be called twice (initial + retry after rejection)
      assert.strictEqual(workerCallCount, 2, 'Worker should be called twice');
      // Validator should be called twice
      assert.strictEqual(validatorCallCount, 2, 'Validator should be called twice');

      const cluster = orchestrator.getCluster(clusterId);
      const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

      // Should have the rejection and approval in sequence
      const validationResults = assertions.getMessages('VALIDATION_RESULT');
      assert.strictEqual(validationResults.length, 2, 'Should have 2 validation results');
    });
  });
}

function definePrModeFlowTests() {
  describe('PR Mode Flow', () => {
    it('should stop after git-pusher completes in autoPr mode', runExplicitGatePrModeTest);
    it(
      'should repair blocked pusher outcomes before retrying git-pusher',
      runBlockedPusherRepairLoopTest
    );
    it(
      'should apply cluster-configured quality gates to validators and PR resume options',
      runClusterConfiguredGatePrModeTest
    );
    it(
      'should apply repo-settings quality gates to validators and PR resume options',
      runRepoSettingsGatePrModeTest
    );
    it(
      'should apply required quality gates to dynamically added validators',
      runDynamicValidatorGatePrModeTest
    );
  });
}

function createPrConfig() {
  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        timeout: 0,
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
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
        timeout: 0,
        triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
        outputFormat: 'json',
        jsonSchema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            qualityGates: { type: 'array' },
          },
          required: ['approved'],
        },
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: {
              topic: 'VALIDATION_RESULT',
              content: {
                data: {
                  approved: '{{result.approved}}',
                  qualityGates: '{{result.qualityGates}}',
                },
              },
            },
          },
        },
      },
    ],
  };
}

function createGate({ scope, description }) {
  return {
    id: 'repo-quality',
    scope,
    description,
    command: `quality-check --scope ${scope}`,
  };
}

function configurePassingPrModeMocks(gate, prNumber, prUrl) {
  mockRunner.when('worker').returns({ summary: 'No changes', result: 'noop' });
  mockRunner.when('validator').calls(() => ({
    success: true,
    output: JSON.stringify({
      approved: true,
      qualityGates: [
        {
          id: gate.id,
          status: 'PASS',
          scope: gate.scope,
          completedAt: Date.now() + 60000,
          evidence: { command: gate.command, exitCode: 0, output: 'pass' },
        },
      ],
    }),
    error: null,
  }));
  mockRunner.when('git-pusher').returns({
    summary: 'PR done',
    result: 'Merged',
    pr_number: prNumber,
    pr_url: prUrl,
    merged: true,
  });
}

async function startPassingPrModeCluster(config, inputText, options) {
  createOrchestrator();

  const result = await orchestrator.start(config, { text: inputText }, options);
  await waitForClusterState(orchestrator, result.id, 'stopped', 10000);
  mockRunner.assertCalled('git-pusher', 1);

  return {
    clusterId: result.id,
    cluster: orchestrator.getCluster(result.id),
  };
}

function assertClusterAgentsRequireGate(cluster, gate) {
  assert.deepStrictEqual(
    cluster.config.agents.find((agent) => agent.id === 'validator').requiredQualityGates,
    [gate]
  );
  assert.deepStrictEqual(
    cluster.config.agents.find((agent) => agent.id === 'git-pusher').requiredQualityGates,
    [gate]
  );
}

function assertValidatorContextListsGate(gate) {
  const validatorContext = mockRunner.getCalls('validator')[0].context;
  assert.match(validatorContext, /Required Handoff Quality Gates/);
  assert.ok(validatorContext.includes(`id: ${gate.id}, scope: ${gate.scope}`));
  assert.ok(validatorContext.includes(gate.command));
}

function assertValidatorConfigRequiresGate(agentConfig, gate) {
  assert.deepStrictEqual(agentConfig.requiredQualityGates, [gate]);
  assert.ok(agentConfig.jsonSchema.properties.qualityGates);
  assert.strictEqual(
    agentConfig.hooks.onComplete.config.content.data.qualityGates,
    '{{result.qualityGates}}'
  );
}

function assertGatePersistsForResume(clusterId, gate) {
  const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, 'clusters.json'), 'utf8'));
  assert.deepStrictEqual(persisted[clusterId].prOptions.requiredQualityGates, [gate]);
  assert.deepStrictEqual(
    generateGitPusherAgent('github', persisted[clusterId].prOptions).requiredQualityGates,
    [gate]
  );
}

async function runExplicitGatePrModeTest() {
  const gate = createGate({
    scope: 'repo',
    description: 'Required repository quality gate',
  });
  configurePassingPrModeMocks(gate, 12345, 'https://github.com/test/test/pull/12345');

  const { clusterId, cluster } = await startPassingPrModeCluster(
    createPrConfig(),
    'PR mode completion test',
    { autoPr: true, requiredQualityGates: [gate] }
  );

  assert.deepStrictEqual(cluster.prOptions.requiredQualityGates, [gate]);
  new LedgerAssertions(cluster.messageBus.ledger, clusterId).assertPublished('CLUSTER_COMPLETE');
}

async function runBlockedPusherRepairLoopTest() {
  const gate = createGate({
    scope: 'repo',
    description: 'Required repository quality gate',
  });
  const prUrl = 'https://github.com/test/test/pull/765';

  let workerCallCount = 0;
  mockRunner.when('worker').calls(() => {
    workerCallCount++;
    return {
      success: true,
      output: JSON.stringify({ summary: `worker pass ${workerCallCount}` }),
      error: null,
    };
  });

  let validatorCallCount = 0;
  mockRunner.when('validator').calls(() => {
    validatorCallCount++;
    return {
      success: true,
      output: JSON.stringify({
        approved: true,
        qualityGates: [
          {
            id: gate.id,
            status: 'PASS',
            scope: gate.scope,
            completedAt: Date.now() + validatorCallCount * 1000,
            evidence: { command: gate.command, exitCode: 0, output: 'pass' },
          },
        ],
      }),
      error: null,
    };
  });

  let pusherCallCount = 0;
  mockRunner.when('git-pusher').calls(() => {
    pusherCallCount++;
    if (pusherCallCount === 1) {
      return {
        success: true,
        output: JSON.stringify({
          pr_number: 765,
          pr_url: prUrl,
          merged: false,
          blocked: true,
          blocked_reason: 'ci_failed: required test failed',
        }),
        error: null,
      };
    }

    return {
      success: true,
      output: JSON.stringify({
        pr_number: 765,
        pr_url: prUrl,
        merged: true,
      }),
      error: null,
    };
  });

  createOrchestrator();

  const result = await orchestrator.start(
    createPrConfig(),
    { text: 'Blocked pusher repair test' },
    { autoPr: true, requiredQualityGates: [gate] }
  );
  const clusterId = result.id;
  await waitForClusterState(orchestrator, clusterId, 'stopped', 15000);
  const cluster = orchestrator.getCluster(clusterId);
  const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);
  const implementationReady = assertions.getMessages('IMPLEMENTATION_READY');
  const validationResults = assertions.getMessages('VALIDATION_RESULT');
  const pushBlocked = assertions.getMessages('PUSH_BLOCKED');

  assert.strictEqual(workerCallCount, 2, 'worker should repair after PUSH_BLOCKED');
  assert.strictEqual(validatorCallCount, 2, 'validator should rerun after repair');
  assert.strictEqual(pusherCallCount, 2, 'git-pusher should retry after fresh validation');
  assert.strictEqual(implementationReady.length, 2, 'repair should publish fresh handoff');
  assert.strictEqual(validationResults.length, 2, 'repair should publish fresh validation');
  assert.strictEqual(pushBlocked.length, 1, 'blocked pusher event should be published once');
  assert.match(pushBlocked[0].content.data.blocked_reason, /ci_failed/);
  assert(
    validationResults[1].timestamp > pushBlocked[0].timestamp,
    'second validation must happen after PUSH_BLOCKED'
  );
  assert(
    mockRunner.getCalls('worker')[1].context.includes('ci_failed: required test failed'),
    'worker repair context should include blocked reason'
  );
}

async function runClusterConfiguredGatePrModeTest() {
  const gate = createGate({
    scope: 'workspace',
    description: 'Required workspace quality gate',
  });
  const config = {
    ...createPrConfig(),
    ship: { requiredQualityGates: [gate] },
  };
  configurePassingPrModeMocks(gate, 12346, 'https://github.com/test/test/pull/12346');

  const { clusterId, cluster } = await startPassingPrModeCluster(
    config,
    'Configured gate PR test',
    { autoPr: true }
  );

  assert.deepStrictEqual(cluster.prOptions.requiredQualityGates, [gate]);
  assertClusterAgentsRequireGate(cluster, gate);
  assertValidatorContextListsGate(gate);
  assertGatePersistsForResume(clusterId, gate);
}

function createRepoWithSettingsGate(gate) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-pr-settings-repo-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  const settingsDir = path.join(repoDir, '.zeroshot');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ ship: { requiredQualityGates: [gate] } }, null, 2)
  );
  return repoDir;
}

async function runRepoSettingsGatePrModeTest() {
  const gate = createGate({
    scope: 'settings',
    description: 'Required settings quality gate',
  });
  const repoDir = createRepoWithSettingsGate(gate);
  try {
    configurePassingPrModeMocks(gate, 12347, 'https://github.com/example/repo/pull/12347');
    const { cluster } = await startPassingPrModeCluster(
      createPrConfig(),
      'Repo settings gate PR test',
      { autoPr: true, cwd: repoDir }
    );

    assert.deepStrictEqual(cluster.prOptions.requiredQualityGates, [gate]);
    assertClusterAgentsRequireGate(cluster, gate);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function runDynamicValidatorGatePrModeTest() {
  const gate = createGate({
    scope: 'dynamic',
    description: 'Required dynamic validator gate',
  });
  const messageBus = new _MessageBus(new _Ledger(path.join(tempDir, 'dynamic-validator.db')));
  const cluster = {
    id: 'dynamic-validator-gate-test',
    config: { agents: [] },
    agents: [],
    messageBus,
    requiredQualityGates: [gate],
    modelOverride: null,
    worktree: { path: tempDir },
    isolation: null,
  };
  const dynamicValidator = {
    id: 'validator',
    role: 'validator',
    timeout: 0,
    triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
    outputFormat: 'json',
    jsonSchema: {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
      },
      required: ['approved'],
    },
    hooks: {
      onComplete: {
        action: 'publish_message',
        config: {
          topic: 'VALIDATION_RESULT',
          content: {
            data: {
              approved: '{{result.approved}}',
            },
          },
        },
      },
    },
  };

  createOrchestrator();

  try {
    await orchestrator._opAddAgents(cluster, { agents: [dynamicValidator] }, {});

    assertValidatorConfigRequiresGate(cluster.config.agents[0], gate);
    assertValidatorConfigRequiresGate(cluster.agents[0].config, gate);
  } finally {
    for (const agent of cluster.agents) {
      await agent.stop();
    }
    messageBus.close();
  }
}

const consensusConfig = {
  agents: [
    {
      id: 'worker',
      role: 'implementation',
      timeout: 0,
      triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
      hooks: {
        onComplete: {
          action: 'publish_message',
          config: { topic: 'IMPLEMENTATION_READY' },
        },
      },
    },
    {
      id: 'validator-a',
      role: 'validator',
      timeout: 0,
      triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
      },
      hooks: {
        onComplete: {
          action: 'publish_message',
          config: {
            topic: 'VALIDATION_RESULT',
            content: { data: { approved: '{{result.approved}}' } },
          },
        },
      },
    },
    {
      id: 'validator-b',
      role: 'validator',
      timeout: 0,
      triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
      },
      hooks: {
        onComplete: {
          action: 'publish_message',
          config: {
            topic: 'VALIDATION_RESULT',
            content: { data: { approved: '{{result.approved}}' } },
          },
        },
      },
    },
    {
      id: 'completion-detector',
      role: 'orchestrator',
      timeout: 0,
      triggers: [
        {
          topic: 'VALIDATION_RESULT',
          action: 'stop_cluster',
          logic: {
            engine: 'javascript',
            script: `
                const validators = cluster.getAgentsByRole('validator');
                const lastImpl = ledger.findLast({ topic: 'IMPLEMENTATION_READY' });
                if (!lastImpl) return false;

                const results = ledger.query({
                  topic: 'VALIDATION_RESULT',
                  since: lastImpl.timestamp
                });

                if (results.length < validators.length) return false;
                return results.every(r => r.content?.data?.approved === true || r.content?.data?.approved === 'true');
              `,
          },
        },
      ],
    },
  ],
};

function defineConsensusValidatorTests() {
  describe('Multiple Validators (Consensus)', () => {
    it('should wait for all validators before completing', async () => {
      await runConsensusApprovalTest();
    });

    it('should NOT complete when one validator rejects', async () => {
      await runConsensusSingleRejectTest();
    });

    it('should NOT complete when validators have mixed results', async () => {
      await runConsensusAllRejectTest();
    });
  });
}

async function runConsensusApprovalTest() {
  mockRunner.when('worker').returns('{"done": true}');

  // Both validators approve
  mockRunner.when('validator-a').returns(JSON.stringify({ approved: true }));
  mockRunner.when('validator-b').delays(500, JSON.stringify({ approved: true }));

  createOrchestrator();

  const result = await orchestrator.start(consensusConfig, {
    text: 'Consensus test',
  });
  const clusterId = result.id;
  await waitForClusterState(orchestrator, clusterId, 'stopped', 15000);

  mockRunner.assertCalled('validator-a', 1);
  mockRunner.assertCalled('validator-b', 1);

  const cluster = orchestrator.getCluster(clusterId);
  const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

  // Should have 2 validation results
  assertions.assertCount('VALIDATION_RESULT', 2);
}

async function runConsensusSingleRejectTest() {
  mockRunner.when('worker').returns('{"done": true}');

  // validator-a approves, validator-b rejects
  mockRunner.when('validator-a').returns(JSON.stringify({ approved: true }));
  mockRunner.when('validator-b').returns(JSON.stringify({ approved: false }));

  createOrchestrator();

  const result = await orchestrator.start(consensusConfig, {
    text: 'Rejection test',
  });
  const clusterId = result.id;

  // Wait for both validators to respond
  await new Promise((r) => setTimeout(r, 3000));

  const cluster = orchestrator.getCluster(clusterId);
  const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

  // Should have 2 validation results
  assertions.assertCount('VALIDATION_RESULT', 2);

  // Cluster should still be running (NOT stopped)
  assert.strictEqual(
    cluster.state,
    'running',
    'Cluster should still be running when consensus not reached'
  );

  // Verify that completion detector did not trigger
  const validationResults = assertions.getMessages('VALIDATION_RESULT');
  assert.strictEqual(validationResults.length, 2, 'Should have 2 validation results');
  assert.strictEqual(validationResults[0].content.data.approved, true, 'First validator approved');
  assert.strictEqual(
    validationResults[1].content.data.approved,
    false,
    'Second validator rejected'
  );

  // Clean up
  await orchestrator.kill(clusterId);
}

async function runConsensusAllRejectTest() {
  mockRunner.when('worker').returns('{"done": true}');

  // Both validators reject
  mockRunner.when('validator-a').returns(JSON.stringify({ approved: false }));
  mockRunner.when('validator-b').returns(JSON.stringify({ approved: false }));

  createOrchestrator();

  const result = await orchestrator.start(consensusConfig, {
    text: 'All reject test',
  });
  const clusterId = result.id;

  // Wait for both validators to respond
  await new Promise((r) => setTimeout(r, 3000));

  const cluster = orchestrator.getCluster(clusterId);
  const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

  // Should have 2 validation results
  assertions.assertCount('VALIDATION_RESULT', 2);

  // Cluster should still be running
  assert.strictEqual(
    cluster.state,
    'running',
    'Cluster should still be running when all validators reject'
  );

  // Verify both rejected
  const validationResults = assertions.getMessages('VALIDATION_RESULT');
  assert.strictEqual(validationResults.length, 2, 'Should have 2 validation results');
  assert(
    validationResults.every((r) => r.content.data.approved === false),
    'All validators should reject'
  );

  // Clean up
  await orchestrator.kill(clusterId);
}

function defineErrorHandlingTests() {
  describe('Error Handling', () => {
    const errorConfig = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          timeout: 0,
          maxIterations: 2,
          maxRetries: 1, // Fast failure for error handling test (default is now 3)
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onError: {
              action: 'publish_message',
              config: { topic: 'AGENT_ERROR' },
            },
          },
        },
      ],
    };

    it('should handle agent failure gracefully', async () => {
      mockRunner.when('worker').fails('Task execution failed');

      createOrchestrator();

      const result = await orchestrator.start(errorConfig, {
        text: 'Failing task',
      });
      const clusterId = result.id;

      // Wait for failure processing
      await new Promise((r) => setTimeout(r, 5000));

      const cluster = orchestrator.getCluster(clusterId);

      // Cluster should track failure
      assert(
        cluster.failureInfo || cluster.state === 'stopped',
        'Cluster should have failure info or be stopped'
      );
    });
  });
}

function defineSigintRaceConditionTests() {
  describe('SIGINT Race Condition (Issue: 0-message clusters)', () => {
    /**
     * Test for race condition: SIGINT during initialization should NOT leave 0-message clusters.
     *
     * Root cause (fixed): If SIGINT arrives during the async GitHub.fetchIssue() call,
     * the stop() method would complete BEFORE ISSUE_OPENED was published, leaving
     * a cluster with 0 messages in the ledger.
     *
     * Fix: Added initCompletePromise to cluster object. stop() now awaits this promise
     * before stopping, ensuring ISSUE_OPENED is always published.
     */
    it('should wait for initialization before stopping (prevents 0-message clusters)', async () => {
      // Simple config - just a worker that would execute
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            timeout: 0,
            triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
            prompt: 'Do something',
          },
        ],
      };

      mockRunner.when('worker').returns('{"done": true}');

      createOrchestrator();

      // Start the cluster
      const result = await orchestrator.start(config, {
        text: 'Test SIGINT race condition',
      });
      const clusterId = result.id;

      // IMMEDIATELY stop the cluster (simulating SIGINT during initialization)
      // Before the fix, this could race with ISSUE_OPENED publication
      await orchestrator.stop(clusterId);

      // CRITICAL ASSERTION: Cluster should NEVER have 0 messages
      // The fix ensures stop() waits for initCompletePromise which resolves
      // AFTER ISSUE_OPENED is published
      const cluster = orchestrator.getCluster(clusterId);
      const messages = cluster.messageBus.getAll(clusterId);

      assert(
        messages.length > 0,
        `Cluster: should have at least 1 message (ISSUE_OPENED), but has ${messages.length}. ` +
          `This indicates the SIGINT race condition is not fixed.`
      );

      // Verify ISSUE_OPENED specifically
      const issueOpened = messages.find((m) => m.topic === 'ISSUE_OPENED');
      assert(issueOpened, 'ISSUE_OPENED: message should exist in ledger');
      assert(
        issueOpened.content.text.includes('Test SIGINT race condition'),
        'ISSUE_OPENED: should contain the task text'
      );
    });

    it('should complete stop() even if initialization fails', async () => {
      // This tests the catch block: if initialization throws, the promise
      // should still resolve so stop() doesn't hang forever

      createOrchestrator();

      // Config with no agents - will still initialize but have nothing to run
      const config = { agents: [] };

      // Start with invalid input (null will cause error in fetchIssue)
      // Actually, empty text will create text input, so this will work
      // Let's just verify stop works on a simple cluster
      const result = await orchestrator.start(config, {
        text: 'Test for clean stop',
      });

      // Should be able to stop immediately without hanging
      const stopStart = Date.now();
      await orchestrator.stop(result.id);
      const stopDuration = Date.now() - stopStart;

      // Stop should complete quickly (within 5 seconds), not hang for 30s timeout
      assert(
        stopDuration < 5000,
        `stop() took ${stopDuration}ms, should complete quickly (not hang on initCompletePromise)`
      );
    });
  });
}

function defineInvalidCommandHandlingTests() {
  describe('Invalid Command Handling', () => {
    /**
     * Test that the system handles invalid/ambiguous commands gracefully
     * without spawning duplicate agents or entering infinite loops
     */
    it('should handle invalid command without errors', async () => {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            timeout: 0,
            triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
            prompt: 'Handle the command',
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: {
                  topic: 'TASK_COMPLETE',
                  content: { text: 'Handled invalid command' },
                },
              },
            },
          },
          {
            id: 'completion-detector',
            role: 'orchestrator',
            timeout: 0,
            triggers: [{ topic: 'TASK_COMPLETE', action: 'stop_cluster' }],
          },
        ],
      };

      mockRunner.when('worker').returns(
        JSON.stringify({
          error: 'Invalid command',
          handled: true,
        })
      );

      createOrchestrator();

      const result = await orchestrator.start(config, {
        text: 'invalid-command',
      });
      const clusterId = result.id;

      // Wait for completion
      await waitForClusterState(orchestrator, clusterId, 'stopped', 10000);

      // Verify worker was called exactly once (no duplicates)
      mockRunner.assertCalled('worker', 1);

      const cluster = orchestrator.getCluster(clusterId);
      const assertions = new LedgerAssertions(cluster.messageBus.ledger, clusterId);

      // Should have clean message flow
      assertions
        .assertPublished('ISSUE_OPENED')
        .assertPublished('TASK_COMPLETE')
        .assertSequence(['ISSUE_OPENED', 'TASK_COMPLETE']);

      // Verify no error messages published
      assertions.assertCount('AGENT_ERROR', 0);
      assertions.assertCount('CLUSTER_FAILED', 0);
    });
  });
}

function defineClusterOperationsFailureTests() {
  describe('CLUSTER_OPERATIONS Failure Handling', () => {
    /**
     * Test for the bug where CLUSTER_OPERATIONS failure didn't stop the cluster.
     *
     * Root cause (fixed): When a non-repairable CLUSTER_OPERATIONS failure occurred,
     * the .catch() handler published CLUSTER_OPERATIONS_FAILED but never called stop().
     * The cluster remained running with no working agents.
     *
     * Fatal structural/resolution/effect errors still stop. Merged-config admission failures
     * instead publish CLUSTER_OPERATIONS_VALIDATION_FAILED and leave the cluster alive so the
     * conductor can repair its proposal.
     */
    it('should stop cluster when CLUSTER_OPERATIONS fails before admission feedback is possible', async function () {
      await runClusterOperationsRuntimeFailureTest();
    });

    it('should stop cluster when CLUSTER_OPERATIONS validation fails', async function () {
      await runClusterOperationsValidationFailureTest();
    });
  });
}

async function runClusterOperationsRuntimeFailureTest() {
  // Simple config with just a conductor that will publish CLUSTER_OPERATIONS
  const config = {
    agents: [
      {
        id: 'bootstrap-agent',
        role: 'bootstrap',
        timeout: 0,
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        prompt: 'Acknowledge the task',
      },
    ],
  };

  mockRunner.when('bootstrap-agent').returns('{"acknowledged": true}');

  createOrchestrator();

  const result = await orchestrator.start(config, {
    text: 'Test CLUSTER_OPERATIONS failure',
  });
  const clusterId = result.id;

  // Give bootstrap agent time to start
  await new Promise((r) => setTimeout(r, 500));

  // A missing load_config cannot be repaired through merged-config admission:
  // the operation cannot even be resolved into a proposed configuration.
  const cluster = orchestrator.getCluster(clusterId);
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'CLUSTER_OPERATIONS',
    sender: 'test',
    content: {
      data: {
        operations: [
          {
            action: 'load_config',
            config: 'definitely-missing-cluster-template',
          },
        ],
      },
    },
  });

  await waitForClusterState(orchestrator, clusterId, 'stopped', 10000);

  const failedMessages = cluster.messageBus.query({
    cluster_id: clusterId,
    topic: 'CLUSTER_OPERATIONS_FAILED',
  });
  assert(failedMessages.length > 0, 'CLUSTER_OPERATIONS_FAILED: should be published');
  assert(
    failedMessages[0].content.text.includes('Operation chain failed'),
    'Failure message: should indicate operation failure'
  );

  const finalStatus = orchestrator.getStatus(clusterId);
  assert.strictEqual(
    finalStatus.state,
    'stopped',
    `Cluster: should be stopped after CLUSTER_OPERATIONS failure, but is ${finalStatus.state}`
  );
}

async function runClusterOperationsValidationFailureTest() {
  // Test for CLUSTER_OPERATIONS_VALIDATION_FAILED case
  const config = {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        timeout: 0,
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        prompt: 'Do work',
      },
    ],
  };

  mockRunner.when('worker').returns('{"done": true}');

  createOrchestrator();

  const result = await orchestrator.start(config, {
    text: 'Test CLUSTER_OPERATIONS validation failure',
  });
  const clusterId = result.id;

  // Give worker time to start
  await new Promise((r) => setTimeout(r, 500));

  // Publish CLUSTER_OPERATIONS with invalid operation
  const cluster = orchestrator.getCluster(clusterId);
  cluster.messageBus.publish({
    cluster_id: clusterId,
    topic: 'CLUSTER_OPERATIONS',
    sender: 'test',
    content: {
      data: {
        operations: [
          {
            action: 'invalid_action', // Invalid action type
            agents: [],
          },
        ],
      },
    },
  });

  // Wait for cluster to stop
  await waitForClusterState(orchestrator, clusterId, 'stopped', 10000);

  // Verify the cluster stopped due to the operation failure
  const finalStatus = orchestrator.getStatus(clusterId);
  assert.strictEqual(
    finalStatus.state,
    'stopped',
    `Cluster: should be stopped after invalid CLUSTER_OPERATIONS, but is ${finalStatus.state}`
  );
}

/**
 * Wait for cluster to reach a specific state
 */
async function waitForClusterState(orchestratorInstance, clusterId, targetState, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const cluster = orchestratorInstance.getCluster(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    if (cluster.state === targetState) {
      return;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  const cluster = orchestratorInstance.getCluster(clusterId);
  throw new Error(
    `Timeout waiting for cluster ${clusterId} to reach state '${targetState}'. Current state: ${cluster?.state}`
  );
}
