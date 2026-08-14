const { strict: assert } = require('node:assert');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');

const { setupE2ERepo, cleanupE2ERepo, runZeroshot } = require('./helpers/e2e-harness');
const { extractTaskLogProviderOutput } = require('./helpers/task-log');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'codex-terminal-stress-config.json');
const FAKE_CODEX_PATH = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-terminal-stress.js');
const STRESS_BYTES = 12 * 1024 * 1024;
const TERMINAL_SECRET = 'sk-zs-secret-qualification';
const TERMINAL_ERROR = `insufficient_quota: Authorization: Bearer ${TERMINAL_SECRET}`;
const SAFE_ERROR = 'Provider codex failed (quota; permanent-pattern)';

function diagnosticReceipt() {
  return {
    byteLength: Buffer.byteLength(TERMINAL_ERROR),
    sha256: createHash('sha256').update(TERMINAL_ERROR).digest('hex'),
  };
}

function readFailedTaskLog(homeDir) {
  const storePath = path.join(homeDir, '.claude-zeroshot', 'store.db');
  const database = new Database(storePath, { readonly: true, fileMustExist: true });
  let tasks;
  try {
    tasks = database.prepare('SELECT status, error, log_file FROM tasks').all();
  } catch (error) {
    database.close();
    throw error;
  }
  database.close();
  assert.strictEqual(tasks.length, 1, 'permanent provider failure must run exactly once');
  assert.strictEqual(tasks[0].status, 'failed', tasks[0].error || 'task did not fail');
  assertRedacted(String(tasks[0].error || ''));
  return fs.readFileSync(tasks[0].log_file, 'utf8');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollCliStatus(env, clusterId, predicate, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastResult;
  while (Date.now() - startedAt < timeoutMs) {
    lastResult = runZeroshot(env, ['status', clusterId, '--json']);
    if (lastResult.status === 0) {
      const status = JSON.parse(lastResult.stdout);
      if (predicate(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `status predicate not met for ${clusterId}: ${lastResult?.stderr || lastResult?.stdout || ''}`
  );
}

async function waitForPidExit(pid, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`daemon pid ${pid} did not exit within ${timeoutMs}ms`);
}

function startDetachedFailure(env, issueDir) {
  const issuePath = path.join(issueDir, 'failing-task.md');
  const expectedOutputPath = path.join(issueDir, 'expected-failed-provider-output.jsonl');
  fs.writeFileSync(issuePath, '# Synthetic terminal failure stress\n');
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
      FAKE_CODEX_EXPECTED_OUTPUT: expectedOutputPath,
      FAKE_CODEX_STRESS_BYTES: String(STRESS_BYTES),
      FAKE_CODEX_TERMINAL_FAILURE: '1',
      FAKE_CODEX_START_DELAY_MS: '2000',
      timeout: 15000,
    }
  );
  assert.strictEqual(run.status, 0, `STDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`);
  const match = /Started (\S+)/.exec(run.stdout);
  assert.ok(match, `expected detached cluster id in:\n${run.stdout}`);
  return { clusterId: match[1], expectedOutputPath };
}

function assertProviderEnvelope(value) {
  assert.strictEqual(value.provider, 'codex');
  assert.strictEqual(value.event, 'turn.failed');
  assert.strictEqual(value.category, 'quota');
  assert.strictEqual(value.kind, 'permanent-pattern');
  assert.strictEqual(value.retryable, false);
  assert.deepStrictEqual(value.diagnostic, diagnosticReceipt());
}

function assertRedacted(serialized) {
  assert.doesNotMatch(serialized, new RegExp(TERMINAL_SECRET));
  assert.doesNotMatch(serialized, /insufficient_quota|Authorization: Bearer/);
}

function exportCluster(env, clusterId) {
  const outputPath = path.join(env.homeDir, `${clusterId}-export.json`);
  const result = runZeroshot(env, [
    'export',
    clusterId,
    '--output',
    outputPath,
    '--format',
    'json',
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const text = fs.readFileSync(outputPath, 'utf8');
  assertRedacted(text);
  return JSON.parse(text);
}

function assertTerminalMessages(messages, status) {
  const agentErrors = messages.filter((message) => message.topic === 'AGENT_ERROR');
  assert.strictEqual(agentErrors.length, 1);
  assert.strictEqual(agentErrors[0].content.data.error, SAFE_ERROR);
  assert.strictEqual(agentErrors[0].content.data.stack, undefined);
  assertProviderEnvelope(agentErrors[0].content.data);

  const terminal = messages.filter((message) => message.topic === 'CLUSTER_FAILED');
  assert.strictEqual(terminal.length, 1);
  assert.strictEqual(terminal[0].content.data.reason, 'provider_execution_failed');
  assert.strictEqual(terminal[0].content.data.code, 'crash');
  assert.strictEqual(terminal[0].content.data.workerReason, 'declared_failure');
  assertProviderEnvelope(terminal[0].content.data);
  assert.strictEqual(messages.length, status.messageCount);
}

describe('e2e: detached Codex terminal failure', function () {
  this.timeout(90000);

  it('redacts the failed tail and exits with durable infrastructure terminal truth', async function () {
    const env = setupE2ERepo();
    const issueDir = fs.mkdtempSync(path.join(env.homeDir, 'terminal-failure-case-'));
    try {
      fs.symlinkSync(FAKE_CODEX_PATH, path.join(env.binDir, 'codex'));
      const started = startDetachedFailure(env, issueDir);
      const running = await pollCliStatus(
        env,
        started.clusterId,
        (status) => Number.isInteger(status.pid) && status.pid > 1
      );
      await pollCliStatus(env, started.clusterId, (status) => status.state === 'stopped');
      await waitForPidExit(running.pid);

      const expectedOutput = fs.readFileSync(started.expectedOutputPath, 'utf8');
      assert.ok(Buffer.byteLength(expectedOutput) > STRESS_BYTES);
      assert.match(expectedOutput, /const Authorization = benignSource;/);
      assert.match(expectedOutput, new RegExp(TERMINAL_SECRET));
      assert.strictEqual(
        extractTaskLogProviderOutput(readFailedTaskLog(env.homeDir), 'turn.failed'),
        expectedOutput
      );

      const statusResult = runZeroshot(env, ['status', started.clusterId, '--json']);
      assert.strictEqual(statusResult.status, 0, statusResult.stderr);
      assertRedacted(statusResult.stdout);
      const status = JSON.parse(statusResult.stdout);
      assert.deepStrictEqual([status.state, status.pid, status.isZombie], ['stopped', null, false]);
      assert.strictEqual(status.failureInfo.error, SAFE_ERROR);
      assert.strictEqual(status.failureInfo.attempts, 1);
      assert.strictEqual(status.failureInfo.code, 'crash');
      assert.strictEqual(status.failureInfo.workerReason, 'declared_failure');
      assertProviderEnvelope(status.failureInfo);

      const exported = exportCluster(env, started.clusterId);
      assertTerminalMessages(exported.messages, status);
      assert.strictEqual(
        exported.messages.some((message) =>
          ['CLUSTER_COMPLETE', 'TASK_COMPLETE', 'VALIDATION_RESULT'].includes(message.topic)
        ),
        false,
        'provider infrastructure failure must never reach scoreable/verifier completion'
      );
      assert.strictEqual(
        exported.messages.some(
          (message) =>
            message.topic === 'AGENT_LIFECYCLE' && message.content?.data?.event === 'TASK_COMPLETED'
        ),
        false,
        'failed provider turns must not publish a task-completed lifecycle event'
      );
    } finally {
      cleanupE2ERepo(env);
    }
  });
});
