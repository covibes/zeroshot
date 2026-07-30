/**
 * Regression test: never drop trigger-matching messages while an agent is busy.
 *
 * BUG:
 *   Agents dropped trigger-matching messages whenever state !== 'idle'.
 *   In real clusters this can drop VALIDATION_RESULT / QUICK_VALIDATION_RESULT
 *   while the worker or coordinator is executing a task, wedging the cluster.
 *
 * FIX:
 *   Buffer trigger-matching messages while busy and drain once idle.
 */

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Orchestrator = require('../src/orchestrator');
const MockTaskRunner = require('./helpers/mock-task-runner');

describe('Agent message buffering while busy', function () {
  this.timeout(15000);

  let orchestrator;
  let mockRunner;
  let testDir;
  let clusterId;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `zeroshot-buffering-test-${crypto.randomBytes(8).toString('hex')}`
    );
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
    orchestrator = new Orchestrator({
      quiet: true,
      storageDir: testDir,
      skipLoad: true,
      taskRunner: mockRunner,
    });
  });

  afterEach(async () => {
    if (clusterId) {
      try {
        await orchestrator.kill(clusterId);
      } catch {
        // Cluster may already be stopped
      }
    }

    try {
      orchestrator.close();
    } catch {
      /* ignore */
    }

    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('executes worker twice when VALIDATION_RESULT arrives during an in-flight task', async () => {
    mockRunner.when('worker').delays(250, 'done');

    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          modelLevel: 'level2',
          prompt: 'do work',
          triggers: [
            { topic: 'ISSUE_OPENED', action: 'execute_task' },
            { topic: 'VALIDATION_RESULT', action: 'execute_task' },
          ],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'WORK_DONE' },
            },
          },
        },
        {
          id: 'completion-detector',
          role: 'completion-detector',
          modelLevel: 'level2',
          prompt: 'stop after 2 work cycles',
          triggers: [
            {
              topic: 'WORK_DONE',
              action: 'stop_cluster',
              logic: { script: "return ledger.count({ topic: 'WORK_DONE' }) >= 2;" },
            },
          ],
        },
      ],
      completion_detector: {
        type: 'topic',
        config: { topic: 'CLUSTER_COMPLETE' },
      },
    };

    const result = await orchestrator.start(config, { text: 'test' }, { cwd: process.cwd() });
    clusterId = result.id;

    const cluster = orchestrator.getCluster(clusterId);
    expect(cluster).to.exist;

    // Publish a trigger-matching message while the worker is still busy with the first task.
    await new Promise((resolve) => setTimeout(resolve, 50));
    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: 'VALIDATION_RESULT',
      sender: 'consensus-coordinator',
      receiver: 'broadcast',
      timestamp: Date.now(),
      content: { text: 'stage 1 rejected' },
    });

    // Wait for the cluster to stop (completion-detector publishes CLUSTER_COMPLETE after 2 WORK_DONE).
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const current = orchestrator.getCluster(clusterId);
      if (current.state === 'stopped') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const finalCluster = orchestrator.getCluster(clusterId);
    expect(finalCluster.state).to.equal('stopped');

    mockRunner.assertCalled('worker', 2);
  });
});
