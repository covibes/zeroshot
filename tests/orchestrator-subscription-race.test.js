/**
 * Regression test for issue #31: Worker completion messages lost due to
 * race condition in subscription registration.
 *
 * BUG: Orchestrator subscribed to CLUSTER_COMPLETE AFTER agents started,
 * causing completion messages to be missed if task finished quickly.
 *
 * ROOT CAUSE: EventEmitter is synchronous and doesn't replay past events.
 * When agents complete before subscriptions are registered (lines 802-816),
 * the orchestrator never receives the completion message.
 *
 * FIX: Register all subscriptions BEFORE starting agents (before line 769).
 *
 * This test verifies the fix by:
 * 1. Creating a cluster with a fast-completing task (0ms delay)
 * 2. Verifying orchestrator receives CLUSTER_COMPLETE
 * 3. Verifying cluster stops automatically
 */

const { expect } = require('chai');
const Orchestrator = require('../src/orchestrator');
const MockTaskRunner = require('./helpers/mock-task-runner');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let orchestrator;
let mockRunner;
let testDir;
let clusterId;

function registerSubscriptionRaceHooks() {
  beforeEach(function () {
    testDir = path.join(os.tmpdir(), `zeroshot-test-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(testDir, { recursive: true });

    const settingsPath = path.join(testDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          defaultProvider: 'claude',
          autoCheckUpdates: false,
        },
        null,
        2
      )
    );

    mockRunner = new MockTaskRunner();
    mockRunner.when('fast-worker').returns('Task completed successfully');

    orchestrator = new Orchestrator({
      quiet: true,
      storageDir: testDir,
      skipLoad: true,
      taskRunner: mockRunner,
    });
  });

  afterEach(async function () {
    if (clusterId) {
      try {
        await orchestrator.kill(clusterId);
      } catch {
        // Cluster may already be stopped
      }
    }

    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
}

async function waitForStoppedCluster(orchestratorInstance, clusterIdToCheck, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const cluster = orchestratorInstance.getCluster(clusterIdToCheck);
    if (cluster.state === 'stopped') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function registerImmediateCompletionTest() {
  it('should receive CLUSTER_COMPLETE even when task finishes immediately', async function () {
    // Cluster config with fast-completing worker
    const config = {
      agents: [
        {
          id: 'fast-worker',
          role: 'implementation',
          modelLevel: 'level2',
          prompt: 'Complete this task quickly',
          triggers: [
            {
              topic: 'ISSUE_OPENED',
              action: 'execute_task',
            },
          ],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'CLUSTER_COMPLETE',
                content: {
                  data: {
                    reason: 'Task completed by fast-worker',
                  },
                },
              },
            },
          },
        },
      ],
      completion_detector: {
        type: 'topic',
        config: { topic: 'CLUSTER_COMPLETE' },
      },
    };

    // Start cluster with immediate task
    const result = await orchestrator.start(
      config,
      { text: 'Test task that completes immediately' },
      { cwd: process.cwd() }
    );
    clusterId = result.id;

    await waitForStoppedCluster(orchestrator, clusterId, 5000);

    // Verify cluster stopped (not hung in 'running' state)
    const finalCluster = orchestrator.getCluster(clusterId);
    expect(finalCluster.state).to.equal(
      'stopped',
      'Cluster should have stopped automatically after receiving CLUSTER_COMPLETE'
    );

    // Verify worker was actually called
    mockRunner.assertCalled('fast-worker', 1);
  });
}

function registerRapidCompletionTest() {
  it('should handle multiple rapid completions without missing messages', async function () {
    // Configure multiple fast workers that all complete immediately
    mockRunner.when('worker-1').returns('Done 1');
    mockRunner.when('worker-2').returns('Done 2');
    mockRunner.when('worker-3').returns('Done 3');

    const config = {
      agents: [
        {
          id: 'worker-1',
          role: 'implementation',
          modelLevel: 'level2',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'WORKER_DONE',
                content: { data: { worker: 1 } },
              },
            },
          },
        },
        {
          id: 'worker-2',
          role: 'implementation',
          modelLevel: 'level2',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'WORKER_DONE',
                content: { data: { worker: 2 } },
              },
            },
          },
        },
        {
          id: 'worker-3',
          role: 'implementation',
          modelLevel: 'level2',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'WORKER_DONE',
                content: { data: { worker: 3 } },
              },
            },
          },
        },
        {
          id: 'completion-detector',
          role: 'completion-detector',
          modelLevel: 'level2',
          prompt: 'Check if all workers done',
          triggers: [
            {
              topic: 'WORKER_DONE',
              action: 'execute_task',
              logic: `
                const messages = ledger.query({ topic: 'WORKER_DONE' });
                return messages.length === 3;
              `,
            },
          ],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'CLUSTER_COMPLETE',
                content: { data: { reason: 'All workers done' } },
              },
            },
          },
        },
      ],
      completion_detector: {
        type: 'topic',
        config: { topic: 'CLUSTER_COMPLETE' },
      },
    };

    mockRunner.when('completion-detector').returns('All done');

    const result = await orchestrator.start(
      config,
      { text: 'Test multiple rapid completions' },
      { cwd: process.cwd() }
    );
    clusterId = result.id;

    // Wait for completion
    await waitForStoppedCluster(orchestrator, clusterId, 5000);

    const finalCluster = orchestrator.getCluster(clusterId);
    expect(finalCluster.state).to.equal(
      'stopped',
      'Cluster should stop after all workers complete'
    );

    // Verify all workers were called
    mockRunner.assertCalled('worker-1', 1);
    mockRunner.assertCalled('worker-2', 1);
    mockRunner.assertCalled('worker-3', 1);
    mockRunner.assertCalled('completion-detector', 1);
  });
}

describe('Orchestrator Subscription Race Condition (issue #31)', function () {
  this.timeout(10000);

  registerSubscriptionRaceHooks();
  registerImmediateCompletionTest();
  registerRapidCompletionTest();
});
