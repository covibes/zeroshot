/**
 * Tier 1 e2e: resume path. A scenario that always fails exhausts the
 * orchestrator's built-in retry budget (src/agent/agent-lifecycle.js), which
 * publishes AGENT_ERROR and persists cluster.failureInfo
 * (src/orchestrator.js:_registerAgentErrorHandler). For an 'implementation'
 * role agent with 3+ attempts, the orchestrator auto-stops the cluster - no
 * custom onError/topic wiring needed (config-validator's reachability check
 * only tracks hooks.onComplete as a topic producer, so a hand-rolled
 * onError-publishes-a-topic path would be flagged as an unproduced topic).
 * `zeroshot resume` then re-runs the failed agent; pointing it at a
 * succeeding scenario should drive the cluster to completion.
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  setupE2ERepo,
  cleanupE2ERepo,
  runZeroshot,
  readCluster,
  worktreePath,
  scenarioPath,
} = require('./helpers/e2e-harness');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'single-worker-config.json');
const PROVIDER_FAILURE_EXIT_CODE = 20;

function pollUntil(predicate, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Condition not met within ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('e2e: failing agent + resume', function () {
  this.timeout(90000);

  let env;

  beforeEach(() => {
    env = setupE2ERepo();
  });

  afterEach(() => {
    cleanupE2ERepo(env);
  });

  it('records failureInfo on exhaustion and completes after resume with a working scenario', async function () {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'feature.md');
    fs.writeFileSync(issuePath, '# Add feature\n\nDo X.\n');

    const clusterId = 'e2e-failing-agent';
    const firstRun = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      FAKE_AGENT_SCENARIO: scenarioPath('failing-agent'),
    });

    assert.strictEqual(
      firstRun.status,
      PROVIDER_FAILURE_EXIT_CODE,
      `zeroshot run exited ${firstRun.status}\nSTDOUT:\n${firstRun.stdout}\nSTDERR:\n${firstRun.stderr}`
    );

    const failedCluster = await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.failureInfo ? cluster : null;
    }, 30000);
    assert.strictEqual(failedCluster.failureInfo.agentId, 'worker');
    assert.ok(!fs.existsSync(path.join(worktreePath(env, clusterId), 'output.txt')));

    // -d returns once the resume has been scheduled; the process still stays
    // alive until the reconstructed cluster's terminal subscriptions observe
    // completion and stop the resumed agents.
    const resumeResult = runZeroshot(env, ['resume', clusterId, '-d'], {
      FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success'),
      timeout: 15000,
    });
    assert.strictEqual(
      resumeResult.status,
      0,
      `zeroshot resume exited ${resumeResult.status}\nSTDOUT:\n${resumeResult.stdout}\nSTDERR:\n${resumeResult.stderr}`
    );

    const writtenFile = path.join(worktreePath(env, clusterId), 'output.txt');
    await pollUntil(() => fs.existsSync(writtenFile), 30000);
    assert.strictEqual(fs.readFileSync(writtenFile, 'utf8'), 'feature implemented\n');

    fs.rmSync(issueDir, { recursive: true, force: true });
  });
});
