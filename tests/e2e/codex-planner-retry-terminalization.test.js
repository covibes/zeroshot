const { strict: assert } = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const { setupE2ERepo, cleanupE2ERepo, runZeroshot } = require('./helpers/e2e-harness');
const {
  pidExists,
  pollCliStatus,
  waitForPidExit,
  terminateDetachedDaemon,
} = require('./helpers/detached-process');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'codex-retryable-planner-config.json');
const FAKE_CODEX_PATH = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-terminal-stress.js');
const RAW_SECRET = 'sk-zs-retryable-secret';
const RAW_FAILURE =
  `service_unavailable: synthetic retryable provider outage; ` +
  `Authorization: Bearer ${RAW_SECRET}`;
const SAFE_ERROR = 'Provider codex failed (transient; retryable-pattern)';
const DIAGNOSTIC_RECEIPT = {
  byteLength: Buffer.byteLength(RAW_FAILURE),
  sha256: createHash('sha256').update(RAW_FAILURE).digest('hex'),
};

function assertRedacted(serialized) {
  assert.doesNotMatch(serialized, new RegExp(RAW_SECRET));
  assert.doesNotMatch(
    serialized,
    /service_unavailable|synthetic retryable provider outage|Authorization: Bearer/
  );
}

function assertProviderReceipt(value) {
  assert.strictEqual(value.provider, 'codex');
  assert.strictEqual(value.event, 'turn.failed');
  assert.strictEqual(value.category, 'transient');
  assert.strictEqual(value.kind, 'retryable-pattern');
  assert.strictEqual(value.retryable, true);
  assert.deepStrictEqual(value.diagnostic, DIAGNOSTIC_RECEIPT);
}

function expectedAgentOutputEnvelope() {
  return {
    type: 'turn.failed',
    error: { message: SAFE_ERROR },
    zeroshot_failure: {
      provider: 'codex',
      event: 'turn.failed',
      category: 'transient',
      kind: 'retryable-pattern',
      retryable: true,
      diagnostic: DIAGNOSTIC_RECEIPT,
    },
  };
}

function readTaskRows(homeDir) {
  const storePath = path.join(homeDir, '.claude-zeroshot', 'store.db');
  const database = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare(
        `SELECT id, status, error, log_file, pid, process_group_id, exit_code
         FROM tasks ORDER BY created_at, id`
      )
      .all();
  } finally {
    database.close();
  }
}

function exportCluster(env, clusterId, outputPath) {
  const result = runZeroshot(env, [
    'export',
    clusterId,
    '--output',
    outputPath,
    '--format',
    'json',
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const serialized = fs.readFileSync(outputPath, 'utf8');
  assertRedacted(serialized);
  return JSON.parse(serialized);
}

function lifecycleEvents(messages, event) {
  return messages.filter(
    (message) => message.topic === 'AGENT_LIFECYCLE' && message.content?.data?.event === event
  );
}

function assertTerminalMessages(messages, status) {
  const taskStarted = lifecycleEvents(messages, 'TASK_STARTED');
  const taskFailed = lifecycleEvents(messages, 'TASK_FAILED');
  const retryScheduled = lifecycleEvents(messages, 'RETRY_SCHEDULED');
  assert.strictEqual(taskStarted.length, 3);
  assert.strictEqual(taskFailed.length, 3);
  assert.strictEqual(retryScheduled.length, 2);
  assert.deepStrictEqual(
    taskFailed.map((message) => message.content.data.attempt),
    [1, 2, 3]
  );
  assert.deepStrictEqual(
    retryScheduled.map((message) => message.content.data.attempt),
    [1, 2]
  );

  const terminalAgentOutput = messages
    .filter((message) => message.topic === 'AGENT_OUTPUT')
    .map((message) => message.content?.data?.line)
    .filter((line) => typeof line === 'string' && line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((value) => value.type === 'turn.failed');
  assert.strictEqual(terminalAgentOutput.length, 3);
  for (const envelope of terminalAgentOutput) {
    assert.deepStrictEqual(envelope, expectedAgentOutputEnvelope());
  }

  const clusterFailures = messages.filter((message) => message.topic === 'CLUSTER_FAILED');
  assert.strictEqual(clusterFailures.length, 1);
  const clusterFailure = clusterFailures[0];
  assert.strictEqual(clusterFailure.sender, 'planner');
  assert.strictEqual(clusterFailure.content.data.reason, 'provider_execution_failed');
  assert.strictEqual(clusterFailure.content.data.agentId, 'planner');
  assert.strictEqual(clusterFailure.content.data.role, 'planning');
  assert.strictEqual(clusterFailure.content.data.attempts, 3);
  assert.strictEqual(clusterFailure.content.data.code, 'crash');
  assert.strictEqual(clusterFailure.content.data.workerReason, 'declared_failure');
  assertProviderReceipt(clusterFailure.content.data);

  const agentErrors = messages.filter((message) => message.topic === 'AGENT_ERROR');
  assert.strictEqual(agentErrors.length, 1);
  const agentError = agentErrors[0];
  assert.strictEqual(agentError.content.data.error, SAFE_ERROR);
  assert.strictEqual(agentError.content.data.stack, undefined);
  assert.strictEqual(agentError.content.data.agent, 'planner');
  assert.strictEqual(agentError.content.data.role, 'planning');
  assert.strictEqual(agentError.content.data.attempts, 3);
  assert.strictEqual(agentError.content.data.retryBudgetExhausted, true);
  assert.strictEqual(agentError.content.data.workerCode, 'crash');
  assert.strictEqual(agentError.content.data.workerReason, 'declared_failure');
  assertProviderReceipt(agentError.content.data);

  assert.ok(BigInt(String(taskFailed.at(-1).sequence)) < BigInt(String(clusterFailure.sequence)));
  assert.ok(BigInt(String(clusterFailure.sequence)) < BigInt(String(agentError.sequence)));
  assert.strictEqual(messages.length, status.messageCount);

  assert.strictEqual(
    messages.some((message) =>
      ['CLUSTER_COMPLETE', 'TASK_COMPLETE', 'PLAN_READY', 'VALIDATION_RESULT'].includes(
        message.topic
      )
    ),
    false,
    'provider infrastructure failure must never reach scoreable/verifier completion'
  );
  assert.strictEqual(lifecycleEvents(messages, 'TASK_COMPLETED').length, 0);
}

function prepareFixture(env, issueDir) {
  const issuePath = path.join(issueDir, 'task.md');
  const countFile = path.join(issueDir, 'attempt-count');
  const exportPath = path.join(issueDir, 'cluster-export.json');
  fs.writeFileSync(issuePath, '# Synthetic retryable planning failure\n');
  fs.writeFileSync(
    path.join(env.homeDir, '.zeroshot', 'settings.json'),
    `${JSON.stringify({
      autoCheckUpdates: false,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      jitterFactor: 0,
    })}\n`
  );
  fs.symlinkSync(FAKE_CODEX_PATH, path.join(env.binDir, 'codex'));
  return { issuePath, countFile, exportPath };
}

function startDetachedPlanner(env, issuePath, countFile) {
  const run = runZeroshot(
    env,
    [
      'run',
      issuePath,
      '--detach',
      '--provider',
      'codex',
      '--config',
      CONFIG_PATH,
      '--model',
      'gpt-5.6-luna',
      '--strict-schema',
      '--sim',
      'off',
    ],
    {
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      FAKE_CODEX_COUNT_FILE: countFile,
      FAKE_CODEX_DELAY_MS: '250',
      FAKE_CODEX_RETRYABLE_TERMINAL: '1',
      timeout: 15_000,
    }
  );
  assert.strictEqual(run.status, 0, `STDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`);
  const clusterMatch = /Started (\S+)/.exec(run.stdout);
  assert.ok(clusterMatch, `expected detached cluster id in:\n${run.stdout}`);
  return clusterMatch[1];
}

function assertStoppedStatus(env, clusterId, status, daemonPid) {
  const statusResult = runZeroshot(env, ['status', clusterId, '--json']);
  assert.strictEqual(statusResult.status, 0, statusResult.stderr);
  assertRedacted(statusResult.stdout);
  assert.deepStrictEqual([status.state, status.pid, status.isZombie], ['stopped', null, false]);
  assert.strictEqual(status.failureInfo.error, SAFE_ERROR);
  assert.strictEqual(status.failureInfo.agentId, 'planner');
  assert.strictEqual(status.failureInfo.attempts, 3);
  assert.strictEqual(status.failureInfo.iteration, 3);
  assert.strictEqual(status.failureInfo.code, 'crash');
  assert.strictEqual(status.failureInfo.workerReason, 'declared_failure');
  assertProviderReceipt(status.failureInfo);

  const planner = status.agents.find((agent) => agent.id === 'planner');
  assert.ok(planner, 'planner state must remain inspectable after failure');
  assert.deepStrictEqual(
    {
      iteration: planner.iteration,
      currentTask: planner.currentTask,
      currentTaskId: planner.currentTaskId,
      pid: planner.pid,
    },
    { iteration: 3, currentTask: false, currentTaskId: null, pid: null }
  );
  assert.strictEqual(pidExists(daemonPid), false);
}

function assertFailedTasks(homeDir, failureTaskId) {
  const tasks = readTaskRows(homeDir);
  assert.strictEqual(tasks.length, 3);
  assertRedacted(JSON.stringify(tasks));
  for (const task of tasks) {
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.pid, null);
    assert.strictEqual(task.process_group_id, null);
    assert.strictEqual(task.exit_code, 1);
    const rawLog = fs.readFileSync(task.log_file, 'utf8');
    assert.match(rawLog, new RegExp(RAW_SECRET));
    assert.match(rawLog, /service_unavailable|Authorization: Bearer/);
  }
  assert.ok(tasks.some((task) => task.id === failureTaskId));
}

function assertPersistedControlPlane(env, clusterId, exportPath, status) {
  const registry = fs.readFileSync(path.join(env.homeDir, '.zeroshot', 'clusters.json'), 'utf8');
  assertRedacted(registry);
  const exported = exportCluster(env, clusterId, exportPath);
  assertTerminalMessages(exported.messages, status);
}

describe('e2e: detached Codex planning retry exhaustion', function () {
  this.timeout(60_000);

  it('stops cleanly after three retryable turn.failed attempts without leaking diagnostics', async function () {
    const env = setupE2ERepo();
    const issueDir = fs.mkdtempSync(path.join(env.homeDir, 'planner-retry-failure-'));
    let daemonPid = null;
    try {
      const fixture = prepareFixture(env, issueDir);
      const clusterId = startDetachedPlanner(env, fixture.issuePath, fixture.countFile);

      const running = await pollCliStatus(
        env,
        clusterId,
        (status) => Number.isInteger(status.pid) && status.pid > 1
      );
      daemonPid = running.pid;
      const status = await pollCliStatus(
        env,
        clusterId,
        (value) => value.state === 'stopped',
        30_000
      );
      await waitForPidExit(daemonPid);
      assertStoppedStatus(env, clusterId, status, daemonPid);
      assert.strictEqual(fs.readFileSync(fixture.countFile, 'utf8').trim(), '3');
      assertFailedTasks(env.homeDir, status.failureInfo.taskId);
      assertPersistedControlPlane(env, clusterId, fixture.exportPath, status);
    } finally {
      await terminateDetachedDaemon(daemonPid);
      cleanupE2ERepo(env);
    }
  });
});
