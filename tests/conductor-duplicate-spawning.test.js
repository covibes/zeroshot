/**
 * Test conductor duplicate spawning prevention
 *
 * CRITICAL BUG: Junior conductor re-triggers on republished ISSUE_OPENED
 * because both original (sender=system) and republished (sender=system, _republished=true)
 * match the trigger logic.
 *
 * Expected behavior:
 * - ISSUE_OPENED published once at start → junior-conductor classifies ONCE
 * - CLUSTER_OPERATIONS loads agents and republishes ISSUE_OPENED
 * - Republished ISSUE_OPENED has metadata._republished=true
 * - Junior conductor trigger excludes republished → no duplicate spawning
 */

const { expect } = require('chai');
const Orchestrator = require('../src/orchestrator');
const MockTaskRunner = require('./helpers/mock-task-runner');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

describe('Conductor Duplicate Spawning Prevention', function () {
  this.timeout(30000);

  let orchestrator;
  let mockRunner;
  let testDir;
  let clusterId;

  beforeEach(function () {
    // Create isolated test storage
    testDir = path.join(os.tmpdir(), `zeroshot-test-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create isolated settings using the environment override.
    const settingsPath = path.join(testDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          defaultProvider: 'claude',
          defaultConfig: 'conductor-bootstrap',
          autoCheckUpdates: false, // Disable update prompts in tests
        },
        null,
        2
      )
    );

    // Override settings path for ct CLI spawned by agents
    process.env.ZEROSHOT_SETTINGS_FILE = settingsPath;

    // Create mock task runner with behavior for junior-conductor
    // This prevents real Claude CLI execution - the mock returns instantly
    mockRunner = new MockTaskRunner();

    // Junior conductor returns a SIMPLE/TASK classification
    // This triggers CLUSTER_OPERATIONS to load agents and republish ISSUE_OPENED
    mockRunner.when('junior-conductor').returns(
      JSON.stringify({
        complexity: 'SIMPLE',
        taskType: 'TASK',
        reasoning: 'Simple task classification for test',
      })
    );

    // Senior conductor only triggers on CONDUCTOR_ESCALATE (not in this test)
    // but we define a behavior just in case
    mockRunner.when('senior-conductor').returns(
      JSON.stringify({
        complexity: 'SIMPLE',
        taskType: 'TASK',
        reasoning: 'Fallback classification',
      })
    );

    // Worker agent is dynamically spawned via CLUSTER_OPERATIONS from worker-validator template
    mockRunner.when('worker').returns('Implementation complete. All tests pass.');

    // Validator agent is dynamically spawned via CLUSTER_OPERATIONS from worker-validator template
    // It has outputFormat: "json" with jsonSchema requiring approved, summary, errors
    mockRunner.when('validator').returns(
      JSON.stringify({
        approved: true,
        summary: 'Implementation verified successfully',
        errors: [],
      })
    );

    orchestrator = new Orchestrator({
      quiet: true,
      storageDir: testDir,
      skipLoad: true,
      taskRunner: mockRunner, // Inject mock to prevent real Claude CLI execution
    });
  });

  afterEach(async function () {
    if (clusterId) {
      try {
        await orchestrator.kill(clusterId);
      } catch {
        // ignore
      }
    }
    // Cleanup test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    // Restore env var
    delete process.env.ZEROSHOT_SETTINGS_FILE;
  });

  it('should prevent duplicate agent spawning from republished ISSUE_OPENED', async function () {
    // Load conductor-bootstrap config
    const configPath = path.join(__dirname, '..', 'cluster-templates', 'conductor-bootstrap.json');
    const config = orchestrator.loadConfig(configPath);

    // Start cluster with "invalid-command" input (same as user's report)
    const result = await orchestrator.start(
      config,
      { text: 'invalid-command' },
      { cwd: process.cwd() }
    );

    clusterId = result.id;
    const cluster = orchestrator.getCluster(clusterId);

    // Wait for classification and agent spawning to complete
    // With mocks, this is fast - but we still need to wait for async message processing
    // Give enough time for CLUSTER_OPERATIONS to be processed and agents to potentially re-trigger
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // ASSERTIONS

    // 1. Count CLUSTER_OPERATIONS messages (should be 1, not 2)
    const clusterOps = cluster.messageBus.query({
      cluster_id: clusterId,
      topic: 'CLUSTER_OPERATIONS',
    });

    console.log(`\n📊 Test Results:`);
    console.log(`  CLUSTER_OPERATIONS count: ${clusterOps.length}`);

    // 2. Count junior-conductor task executions via MockTaskRunner
    // NOTE: With MockTaskRunner, AGENT_OUTPUT messages are not published
    // because the streaming path is bypassed. Use mock's call tracking instead.
    const juniorCalls = mockRunner.getCalls('junior-conductor');

    console.log(`  Conductor task executions: ${juniorCalls.length}`);

    // 3. Check all ISSUE_OPENED messages for _republished metadata
    const issueMessages = cluster.messageBus.query({
      cluster_id: clusterId,
      topic: 'ISSUE_OPENED',
    });

    console.log(`\n📧 ISSUE_OPENED Messages:`);
    for (const msg of issueMessages) {
      console.log(
        `  [${msg.sender}] republished: ${msg.metadata?._republished || 'undefined'}, timestamp: ${msg.timestamp}`
      );
    }

    // 4. If CLUSTER_OPERATIONS exists, inspect its operations array
    if (clusterOps.length > 0) {
      console.log(`\n🔧 CLUSTER_OPERATIONS Details:`);
      for (let i = 0; i < clusterOps.length; i++) {
        const op = clusterOps[i];
        const operations = op.content?.data?.operations || [];
        console.log(`  Message ${i + 1}:`);
        console.log(`    Sender: ${op.sender}`);
        console.log(`    Operations count: ${operations.length}`);
        for (const operation of operations) {
          if (operation.action === 'publish') {
            console.log(`    Publish operation:`);
            console.log(`      Topic: ${operation.topic}`);
            console.log(`      Metadata: ${JSON.stringify(operation.metadata)}`);
          }
        }
      }
    }

    // 5. Count spawned agents (excluding conductors)
    const spawnedAgents = cluster.agents.filter((a) => a.role !== 'conductor');
    console.log(`\n👥 Spawned Agents (excluding conductors): ${spawnedAgents.length}`);
    for (const agent of spawnedAgents) {
      console.log(`  - ${agent.id} (${agent.role})`);
    }

    // VALIDATION: Fail if duplicates detected
    if (clusterOps.length > 1) {
      console.log(`\n❌ FAILURE: Duplicate spawning detected`);
      console.log(`  CLUSTER_OPERATIONS count: ${clusterOps.length} (expected: 1)`);
      console.log(`  Conductor task executions: ${juniorCalls.length} (expected: 1)`);
    } else if (juniorCalls.length > 1) {
      console.log(`\n❌ FAILURE: Conductor re-triggered`);
      console.log(`  Conductor task executions: ${juniorCalls.length} (expected: 1)`);
    } else {
      console.log(`\n✅ SUCCESS: No duplicate spawning detected`);
      console.log(`  CLUSTER_OPERATIONS count: ${clusterOps.length}`);
      console.log(`  Conductor task executions: ${juniorCalls.length}`);
    }

    // Assertions
    expect(clusterOps.length, 'CLUSTER_OPERATIONS: should be published exactly once').to.equal(1);
    // Use MockTaskRunner's call tracking - AGENT_OUTPUT is not published with mocks
    mockRunner.assertCalled('junior-conductor', 1);

    // Verify republished message has metadata flag
    const republishedMsg = issueMessages.find((m) => m.metadata?._republished === true);
    expect(republishedMsg, 'Republished ISSUE_OPENED: should have _republished metadata').to.exist;

    // Verify publish operation in CLUSTER_OPERATIONS has metadata
    const publishOp = clusterOps[0]?.content?.data?.operations?.find(
      (op) => op.action === 'publish'
    );
    expect(publishOp, 'CLUSTER_OPERATIONS: should contain publish operation').to.exist;
    expect(
      publishOp.metadata,
      'Publish operation: should have metadata with _republished flag'
    ).to.deep.equal({ _republished: true });
  });
});
