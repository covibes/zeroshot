/**
 * Tier 1 e2e: resume --detach must perform a real daemon handoff, matching
 * `run --detach` semantics (issue #637). Before this fix, `resume --detach`
 * ran the resumed agents inside the invoking CLI process and only skipped
 * foreground log streaming - if that process died, the cluster lost its only
 * backing process while clusters.json still said state:'running', producing
 * a zombie that a follow-up `resume` then rejected as "still running".
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Ledger = require('../../src/ledger');

const {
  setupE2ERepo,
  cleanupE2ERepo,
  runZeroshot,
  runZeroshotUntilNaturalExit,
  buildEnv,
  CLI_ENTRY,
  readCluster,
  clustersFilePath,
  clusterDbPath,
  readLedgerMessages,
  worktreePath,
  scenarioPath,
} = require('./helpers/e2e-harness');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'single-worker-config.json');
const PARTIAL_VALIDATION_CONFIG_PATH = path.join(
  __dirname,
  'fixtures',
  'resume-partial-validation-config.json'
);

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

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function overwriteClusterRecord(env, clusterId, patch) {
  const file = clustersFilePath(env);
  const clusters = JSON.parse(fs.readFileSync(file, 'utf8'));
  clusters[clusterId] = { ...clusters[clusterId], ...patch };
  fs.writeFileSync(file, JSON.stringify(clusters, null, 2));
}

function appendLedgerMessage(ledger, clusterId, topic, sender, data = {}) {
  ledger.append({
    cluster_id: clusterId,
    topic,
    sender,
    receiver: 'broadcast',
    content: {
      text: `${sender}: ${topic}`,
      data,
    },
  });
}

function seedRecoveredWorkerFailure(ledger, clusterId) {
  appendLedgerMessage(ledger, clusterId, 'AGENT_ERROR', 'worker', {
    agent: 'worker',
    error: 'task_not_found',
    iteration: 1,
    taskId: 'stale-worker-task',
  });
  appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'worker', {
    event: 'TASK_STARTED',
    agent: 'worker',
    role: 'implementation',
    state: 'executing_task',
    iteration: 2,
    triggeredBy: 'PLAN_READY',
  });
  appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'worker', {
    event: 'TASK_ID_ASSIGNED',
    agent: 'worker',
    role: 'implementation',
    state: 'executing_task',
    taskId: 'recovered-worker-task',
  });
  appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'worker', {
    event: 'TASK_COMPLETED',
    agent: 'worker',
    role: 'implementation',
    state: 'idle',
    iteration: 2,
    taskId: 'recovered-worker-task',
  });
}

function seedPartialValidationState(env, clusterId) {
  const ledger = new Ledger(clusterDbPath(env, clusterId));
  try {
    seedRecoveredWorkerFailure(ledger, clusterId);
    appendLedgerMessage(ledger, clusterId, 'IMPLEMENTATION_READY', 'worker');
    appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'validator-requirements', {
      event: 'TASK_STARTED',
      agent: 'validator-requirements',
      role: 'validator',
      state: 'executing_task',
      iteration: 3,
      triggeredBy: 'IMPLEMENTATION_READY',
    });
    appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'validator-requirements', {
      event: 'TASK_ID_ASSIGNED',
      agent: 'validator-requirements',
      role: 'validator',
      state: 'executing_task',
      taskId: 'interrupted-validator-task',
    });
    appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'validator-code', {
      event: 'TASK_STARTED',
      agent: 'validator-code',
      role: 'validator',
      state: 'executing_task',
      iteration: 3,
    });
    appendLedgerMessage(ledger, clusterId, 'AGENT_LIFECYCLE', 'validator-code', {
      event: 'TASK_COMPLETED',
      agent: 'validator-code',
      role: 'validator',
      state: 'idle',
      iteration: 3,
      taskId: 'completed-validator-task',
    });
    appendLedgerMessage(ledger, clusterId, 'VALIDATION_RESULT', 'validator-code', {
      approved: false,
      errors: ['repair this'],
    });
  } finally {
    ledger.close();
  }

  const cluster = readCluster(env, clusterId);
  const agentStates = cluster.agentStates.map((agent) => {
    if (agent.id === 'validator-requirements') {
      return {
        ...agent,
        state: 'executing_task',
        iteration: 3,
        currentTask: false,
        currentTaskId: 'interrupted-validator-task',
        processPid: 4242,
      };
    }
    if (agent.id === 'validator-code') {
      return {
        ...agent,
        state: 'idle',
        iteration: 3,
        currentTask: false,
        currentTaskId: 'completed-validator-task',
        processPid: null,
      };
    }
    return { ...agent, state: 'idle', currentTask: false };
  });

  overwriteClusterRecord(env, clusterId, {
    state: 'stopped',
    pid: null,
    failureInfo: {
      agentId: 'worker',
      taskId: 'stale-worker-task',
      iteration: 1,
      error: 'task_not_found',
      timestamp: 0,
    },
    agentStates,
  });
}

function countLifecycleEvents(env, clusterId, agentId, event) {
  return readLedgerMessages(env, clusterId, 'AGENT_LIFECYCLE').filter(
    (message) => message.sender === agentId && message.content?.data?.event === event
  ).length;
}

describe('e2e: resume --detach daemon handoff', function () {
  this.timeout(60000);

  let env;

  beforeEach(() => {
    env = setupE2ERepo();
  });

  afterEach(() => {
    cleanupE2ERepo(env);
  });

  for (const detached of [false, true]) {
    const mode = detached ? 'detached' : 'foreground';
    it(`recovers partial validation exactly once in ${mode} mode`, async function () {
      const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
      const issuePath = path.join(issueDir, 'feature.md');
      fs.writeFileSync(issuePath, '# Repair validation\n\nAddress the rejected findings.\n');

      const clusterId = `e2e-partial-validation-${mode}`;
      const initialRun = runZeroshot(
        env,
        ['run', issuePath, '--worktree', '--config', PARTIAL_VALIDATION_CONFIG_PATH],
        {
          ZEROSHOT_CLUSTER_ID: clusterId,
          FAKE_AGENT_SCENARIO: scenarioPath('validator-approve'),
          timeout: 30000,
        }
      );
      assert.strictEqual(
        initialRun.status,
        0,
        `initial fixture run failed\nSTDOUT:\n${initialRun.stdout}\nSTDERR:\n${initialRun.stderr}`
      );
      assert.strictEqual(readCluster(env, clusterId)?.state, 'stopped');

      seedPartialValidationState(env, clusterId);
      const workerStartsBeforeResume = countLifecycleEvents(
        env,
        clusterId,
        'worker',
        'TASK_STARTED'
      );
      const completionCountBeforeResume = readLedgerMessages(
        env,
        clusterId,
        'CLUSTER_COMPLETE'
      ).length;
      const resumeArgs = ['resume', clusterId];
      if (detached) {
        resumeArgs.push('-d');
      }
      const resumeEnv = {
        FAKE_AGENT_SCENARIO: scenarioPath('worker-success'),
        FAKE_AGENT_SCENARIO_VALIDATOR_REQUIREMENTS: scenarioPath('validator-approve'),
        FAKE_AGENT_SCENARIO_WORKER: scenarioPath('worker-success'),
        // Validator recovery includes deliberate 0-15s jitter plus three
        // sequential fake tasks. Process-exit latency is asserted separately.
        timeout: detached ? 30000 : 60000,
      };
      const resumed = detached
        ? runZeroshot(env, resumeArgs, resumeEnv)
        : await runZeroshotUntilNaturalExit(
            env,
            resumeArgs,
            resumeEnv,
            `Cluster ${clusterId} completed.`
          );
      assert.strictEqual(
        resumed.status,
        0,
        `${mode} resume failed\nSTDOUT:\n${resumed.stdout}\nSTDERR:\n${resumed.stderr}`
      );
      if (!detached) {
        assert.notStrictEqual(resumed.completionToExitMs, null);
      }

      if (detached) {
        await pollUntil(
          () =>
            readLedgerMessages(env, clusterId, 'CLUSTER_COMPLETE').length ===
            completionCountBeforeResume + 1,
          30000
        );
      }
      await pollUntil(() => readCluster(env, clusterId)?.state === 'stopped', 30000);

      const validationResults = readLedgerMessages(env, clusterId, 'VALIDATION_RESULT');
      assert.strictEqual(validationResults.length, 2);
      assert.strictEqual(
        validationResults.filter((message) => message.sender === 'validator-code').length,
        1
      );
      assert.strictEqual(
        validationResults.filter((message) => message.sender === 'validator-requirements').length,
        1
      );
      assert.strictEqual(countLifecycleEvents(env, clusterId, 'validator-code', 'TASK_STARTED'), 1);
      assert.strictEqual(
        countLifecycleEvents(env, clusterId, 'validator-requirements', 'TASK_STARTED'),
        2
      );
      assert.strictEqual(
        countLifecycleEvents(env, clusterId, 'worker', 'TASK_STARTED'),
        workerStartsBeforeResume + 1,
        'recovered historical failure must not start the worker before the missing validator reports'
      );
      assert.strictEqual(
        readLedgerMessages(env, clusterId, 'CLUSTER_COMPLETE').length,
        completionCountBeforeResume + 1,
        'worker repair completion must be emitted exactly once'
      );
      assert.ok(
        fs.existsSync(path.join(worktreePath(env, clusterId), 'implementation.txt')),
        'recovered worker must execute in the preserved worktree'
      );
    });
  }

  it('recovers a zombie (state=running, dead pid) via a real detached daemon without a manual stop', async function () {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'feature.md');
    fs.writeFileSync(issuePath, '# Add feature\n\nDo X.\n');

    const clusterId = 'e2e-resume-detach-zombie';
    const firstRun = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      FAKE_AGENT_SCENARIO: scenarioPath('failing-agent'),
    });
    assert.strictEqual(
      firstRun.status,
      0,
      `zeroshot run exited ${firstRun.status}\nSTDOUT:\n${firstRun.stdout}\nSTDERR:\n${firstRun.stderr}`
    );

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.failureInfo ? cluster : null;
    }, 30000);

    const beforePatch = readCluster(env, clusterId);
    assert.ok(beforePatch.config, 'precondition: cluster must have real config before the patch');

    // Simulate exactly the zombie this issue describes: a daemon that owned
    // this cluster died without transitioning state away from 'running'.
    // Before the fix, `resume` trusted this persisted state and rejected the
    // cluster as "still running" even though `status` would call it a zombie.
    overwriteClusterRecord(env, clusterId, { state: 'running', pid: 999999 });

    const resumeStart = Date.now();
    const resumeResult = runZeroshot(env, ['resume', clusterId, '-d'], {
      FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success'),
      timeout: 15000,
    });
    const resumeElapsedMs = Date.now() - resumeStart;

    assert.strictEqual(
      resumeResult.status,
      0,
      `zeroshot resume -d exited ${resumeResult.status}\nSTDOUT:\n${resumeResult.stdout}\nSTDERR:\n${resumeResult.stderr}`
    );
    assert.ok(
      /Resume daemon started/.test(resumeResult.stdout),
      `expected a daemon-handoff message, got:\n${resumeResult.stdout}`
    );

    const pidMatch = /Daemon PID: (\d+)/.exec(resumeResult.stdout);
    assert.ok(pidMatch, `expected "Daemon PID: <n>" in stdout, got:\n${resumeResult.stdout}`);
    const daemonPid = Number(pidMatch[1]);
    assert.notStrictEqual(
      daemonPid,
      999999,
      'daemon must be a freshly spawned process, not the dead pid'
    );

    // The parent must return well before the fake agent (which completes
    // near-instantly) could possibly have finished end-to-end through a
    // worktree setup + full agent lifecycle - proving it handed off rather
    // than running the resume itself.
    assert.ok(
      resumeElapsedMs < 15000,
      `resume --detach took ${resumeElapsedMs}ms, expected a bounded handoff`
    );

    // Right after the parent returns, the daemon has claimed resumeDaemonPid
    // but may not yet have called orchestrator.resume() (which is what
    // flips cluster.pid/state away from the stale zombie values) - that's a
    // real, expected transient window, not a bug. What matters is that a
    // live claimant is recorded immediately, and that the pid/state
    // eventually reflect it (checked by the poll below) rather than getting
    // stuck on the dead zombie pid forever.
    const justAfterHandoff = readCluster(env, clusterId);
    assert.strictEqual(justAfterHandoff.resumeDaemonPid, daemonPid);
    assert.ok(
      isPidAlive(justAfterHandoff.resumeDaemonPid),
      'resumeDaemonPid must be a live process'
    );
    // Worktree/config were preserved through the handoff, not clobbered to a
    // blank setup placeholder (the hazard patchDetachedResumeCluster exists to avoid).
    assert.ok(justAfterHandoff.config, 'cluster config must survive the resume handoff');

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.state === 'stopped' || cluster?.state === 'killed' ? cluster : null;
    }, 30000);

    const writtenFile = path.join(worktreePath(env, clusterId), 'output.txt');
    if (!fs.existsSync(writtenFile)) {
      const logPath = path.join(env.homeDir, '.zeroshot', `${clusterId}-resume-daemon.log`);
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no log)';
      const worktreeDir = worktreePath(env, clusterId);
      const worktreeListing = fs.existsSync(worktreeDir)
        ? fs.readdirSync(worktreeDir)
        : '(missing)';
      throw new Error(
        `output.txt missing at ${writtenFile}\nworktree listing: ${JSON.stringify(worktreeListing)}\nfinal cluster: ${JSON.stringify(readCluster(env, clusterId))}\ndaemon log:\n${logContent}`
      );
    }
    assert.strictEqual(fs.readFileSync(writtenFile, 'utf8'), 'feature implemented\n');

    fs.rmSync(issueDir, { recursive: true, force: true });
  });

  it('lets exactly one daemon win when two resume --detach calls race the same dead-pid cluster', async function () {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'feature.md');
    fs.writeFileSync(issuePath, '# Add feature\n\nDo X.\n');

    const clusterId = 'e2e-resume-detach-race';
    const firstRun = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      FAKE_AGENT_SCENARIO: scenarioPath('failing-agent'),
    });
    assert.strictEqual(firstRun.status, 0, firstRun.stderr);

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.failureInfo ? cluster : null;
    }, 30000);

    overwriteClusterRecord(env, clusterId, { state: 'running', pid: 999999 });

    function spawnResume() {
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn('node', [CLI_ENTRY, 'resume', clusterId, '-d'], {
          cwd: env.repoDir,
          // Deliberately slower than the plain success scenario: the race
          // being tested is "two daemons both trying to claim an in-flight
          // resume", which a near-instant fake agent could resolve (finish
          // + clear resumeDaemonPid) before the second racer ever checks -
          // masking the exact TOCTOU this test exists to catch.
          env: buildEnv(env, {
            FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success-delayed'),
          }),
        });
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    }

    const [first, second] = await Promise.all([spawnResume(), spawnResume()]);
    const results = [first, second];
    const winners = results.filter((r) => r.status === 0);
    const losers = results.filter((r) => r.status !== 0);

    assert.strictEqual(
      winners.length,
      1,
      `expected exactly one winner, got:\n${JSON.stringify(results, null, 2)}`
    );
    assert.strictEqual(
      losers.length,
      1,
      `expected exactly one loser, got:\n${JSON.stringify(results, null, 2)}`
    );
    assert.ok(
      /already has a live resume daemon|is already running|still running/.test(losers[0].stderr),
      `loser should report the conflict, got:\n${losers[0].stderr}`
    );

    await pollUntil(() => {
      const cluster = readCluster(env, clusterId);
      return cluster?.state === 'stopped' || cluster?.state === 'killed' ? cluster : null;
    }, 30000);

    fs.rmSync(issueDir, { recursive: true, force: true });
  });
});
