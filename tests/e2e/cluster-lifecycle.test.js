/**
 * Tier 1 e2e: daemon-mode run plus the observability commands (status/list/
 * logs) an operator would actually use, ported from the now-deleted
 * tests/integration/e2e-framework.test.ts (which could never run - it
 * imported @playwright/test, an uninstalled dependency, and asserted a
 * hardcoded stale version string).
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

function pollUntil(predicate, timeoutMs, intervalMs = 300) {
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

describe('e2e: cluster lifecycle (daemon mode + observability commands)', function () {
  this.timeout(60000);

  let env;

  beforeEach(() => {
    env = setupE2ERepo();
  });

  afterEach(() => {
    cleanupE2ERepo(env);
  });

  it('runs detached and is observable via status/list/logs until completion', async function () {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'feature.md');
    fs.writeFileSync(issuePath, '# Add feature\n\nDo X.\n');

    // NOTE: unlike foreground `run`, the `-d` parent branch always calls
    // generateName('cluster') itself (cli/index.js:shouldRunDetached path) -
    // it does not honor a pre-set ZEROSHOT_CLUSTER_ID the way foreground/resume
    // do, so the id must be parsed from stdout ("Started <id>").
    const startResult = runZeroshot(
      env,
      ['run', issuePath, '-d', '--worktree', '--config', CONFIG_PATH],
      {
        FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success'),
        timeout: 15000,
      }
    );
    assert.strictEqual(
      startResult.status,
      0,
      `zeroshot run -d exited ${startResult.status}\nSTDOUT:\n${startResult.stdout}\nSTDERR:\n${startResult.stderr}`
    );
    const clusterIdMatch = /Started (\S+)/.exec(startResult.stdout);
    assert.ok(clusterIdMatch, `expected "Started <id>" in stdout, got:\n${startResult.stdout}`);
    const clusterId = clusterIdMatch[1];

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster && cluster.state !== 'initializing' ? cluster : null;
    }, 15000);

    const listResult = runZeroshot(env, ['list', '--json']);
    assert.strictEqual(listResult.status, 0, listResult.stderr);
    const listData = JSON.parse(listResult.stdout);
    const clusters = Array.isArray(listData) ? listData : listData.clusters;
    assert.ok(
      clusters.some((c) => c.id === clusterId),
      `expected ${clusterId} in list --json output: ${listResult.stdout}`
    );

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.state === 'stopped' || cluster?.state === 'killed' ? cluster : null;
    }, 30000);

    const statusResult = runZeroshot(env, ['status', clusterId, '--json']);
    assert.strictEqual(statusResult.status, 0, statusResult.stderr);
    const statusData = JSON.parse(statusResult.stdout);
    assert.strictEqual(statusData.id, clusterId);
    assert.ok(['stopped', 'killed'].includes(statusData.state), JSON.stringify(statusData));

    const logsResult = runZeroshot(env, ['logs', clusterId, '-n', '200']);
    assert.strictEqual(logsResult.status, 0, logsResult.stderr);
    assert.ok(
      logsResult.stdout.includes('Implementing the requested feature'),
      `expected fake-agent message text in logs, got:\n${logsResult.stdout}`
    );

    const writtenFile = path.join(worktreePath(env, clusterId), 'output.txt');
    assert.ok(fs.existsSync(writtenFile));

    fs.rmSync(issueDir, { recursive: true, force: true });
  });

  it('preserves a CLI model override through detached conductor load_config', async function () {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'model-override.md');
    const scenarioFile = path.join(issueDir, 'conductor-trivial-task.json');
    let clusterId = null;
    fs.writeFileSync(issuePath, '# Model override\n\nExercise dynamic config loading.\n');
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({
        messages: [
          JSON.stringify({
            complexity: 'TRIVIAL',
            taskType: 'TASK',
            reasoning: 'Use the single-worker route.',
          }),
        ],
        exitCode: 0,
      })
    );

    try {
      const configPath = path.join(
        __dirname,
        '..',
        '..',
        'cluster-templates',
        'conductor-bootstrap.json'
      );
      const startResult = runZeroshot(
        env,
        ['run', issuePath, '-d', '--config', configPath, '--model', 'sonnet'],
        {
          FAKE_AGENT_SCENARIO: scenarioFile,
          timeout: 15000,
        }
      );
      assert.strictEqual(
        startResult.status,
        0,
        `zeroshot run -d exited ${startResult.status}\nSTDOUT:\n${startResult.stdout}\nSTDERR:\n${startResult.stderr}`
      );

      const clusterIdMatch = /Started (\S+)/.exec(startResult.stdout);
      assert.ok(clusterIdMatch, `expected "Started <id>" in stdout, got:\n${startResult.stdout}`);
      clusterId = clusterIdMatch[1];
      const cluster = await pollUntil(() => {
        const current = readCluster(env, clusterId);
        return current?.state === 'stopped' ? current : null;
      }, 30000);

      assert.strictEqual(cluster.modelOverride, 'sonnet');
      assert.ok(
        cluster.config.agents.some((agent) => agent.id === 'worker'),
        'detached conductor should load the worker config'
      );
      for (const agent of cluster.config.agents) {
        assert.strictEqual(
          agent.model,
          'sonnet',
          `persisted agent ${agent.id} should retain the CLI model override`
        );
      }
      assert.strictEqual(cluster.failureInfo, null);
    } finally {
      const cluster = clusterId ? readCluster(env, clusterId) : null;
      if (cluster && !['stopped', 'killed'].includes(cluster.state)) {
        runZeroshot(env, ['kill', clusterId], { timeout: 15000 });
      }
      fs.rmSync(issueDir, { recursive: true, force: true });
    }
  });
});
