const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  cleanupE2ERepo,
  buildEnv,
  CLI_ENTRY,
  runZeroshot,
  scenarioPath,
  setupE2ERepo,
} = require('./helpers/e2e-harness');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'single-worker-config.json');

function runUntilSignal(env, args, envOverrides, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: env.repoDir,
      env: buildEnv(env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`foreground cancellation timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!signalled && stdout.includes(marker)) {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function readBundle(resultPath) {
  const receiptBytes = fs.readFileSync(resultPath);
  const receipt = JSON.parse(receiptBytes);
  const telemetryPath = path.join(path.dirname(resultPath), receipt.telemetry.artifact);
  const telemetryBytes = fs.readFileSync(telemetryPath);
  const observedIdentity = [
    telemetryBytes.length,
    crypto.createHash('sha256').update(telemetryBytes).digest('hex'),
  ];
  assert.deepStrictEqual(
    [receipt.telemetry.byteLength, receipt.telemetry.sha256],
    observedIdentity
  );
  return { receipt, telemetry: JSON.parse(telemetryBytes) };
}

function describeWithE2ERepo(name, defineTests) {
  describe(name, function () {
    this.timeout(60_000);
    let env;
    beforeEach(() => {
      env = setupE2ERepo();
    });
    afterEach(() => {
      cleanupE2ERepo(env);
    });
    defineTests(() => env);
  });
}

describeWithE2ERepo('e2e: foreground benchmark outcomes', (environment) => {
  it('runs the real workflow and commits a verifier-eligible result', function () {
    const env = environment();
    const resultPath = path.join(env.homeDir, 'success-result.json');
    const execution = runZeroshot(
      env,
      [
        'run',
        'Implement the fixture task',
        '--no-isolation',
        '--config',
        CONFIG_PATH,
        '--sim',
        'off',
        '--result-file',
        resultPath,
      ],
      { FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success'), timeout: 30_000 }
    );

    assert.strictEqual(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    const { receipt, telemetry } = readBundle(resultPath);
    assert.strictEqual(receipt.schema, 'zeroshot-benchmark-result/v1');
    assert.strictEqual(receipt.outcome, 'completed');
    assert.strictEqual(receipt.terminalOwner, 'task');
    assert.strictEqual(telemetry.runId, receipt.runId);
    assert.ok(telemetry.messageCount > 0);
    assert.ok(telemetry.tokensByRole._total.count > 0);
    assert.match(execution.stdout, /Result completed committed/);
    const taskStore = new Database(path.join(env.homeDir, '.claude-zeroshot', 'store.db'), {
      readonly: true,
      fileMustExist: true,
    });
    const tasks = taskStore.prepare('SELECT attachable FROM tasks').all();
    taskStore.close();
    assert.deepStrictEqual(tasks, [{ attachable: 0 }], 'result mode must select the pipe watcher');
  });

  it('commits a provider failure and returns its closed transport exit code', function () {
    const env = environment();
    const resultPath = path.join(env.homeDir, 'failure-result.json');
    const execution = runZeroshot(
      env,
      [
        'run',
        'Exercise failure handling',
        '--no-isolation',
        '--config',
        CONFIG_PATH,
        '--sim',
        'off',
        '--result-file',
        resultPath,
      ],
      { FAKE_AGENT_SCENARIO: scenarioPath('failing-agent'), timeout: 30_000 }
    );

    assert.strictEqual(execution.status, 20, `${execution.stdout}\n${execution.stderr}`);
    const { receipt } = readBundle(resultPath);
    assert.strictEqual(receipt.outcome, 'provider_failure');
    assert.strictEqual(receipt.terminalOwner, 'provider');
    assert.strictEqual(receipt.provider, 'claude');
    assert.strictEqual(receipt.kind, 'unknown-retryable');
    assert.ok(!JSON.stringify(receipt).includes('simulated fatal error'));
  });
});

describeWithE2ERepo('e2e: foreground benchmark guards', (environment) => {
  it('rejects a result path in detached mode before starting a cluster', function () {
    const env = environment();
    const resultPath = path.join(env.homeDir, 'detached-result.json');
    const execution = runZeroshot(env, [
      'run',
      'Do not launch',
      '--detach',
      '--no-isolation',
      '--sim',
      'off',
      '--result-file',
      resultPath,
    ]);

    assert.strictEqual(execution.status, 1);
    assert.match(execution.stderr, /result-file requires foreground execution/);
    assert.strictEqual(fs.existsSync(resultPath), false);
  });

  it('settles SIGTERM through Harbor-compatible cancellation before writing a receipt', async function () {
    const env = environment();
    const resultPath = path.join(env.homeDir, 'cancelled-result.json');
    const execution = await runUntilSignal(
      env,
      [
        'run',
        'Exercise cancellation',
        '--no-isolation',
        '--config',
        CONFIG_PATH,
        '--sim',
        'off',
        '--result-file',
        resultPath,
      ],
      { FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success-delayed') },
      'TASK_ID_ASSIGNED'
    );

    assert.strictEqual(execution.signal, null, execution.stderr);
    assert.strictEqual(execution.status, 22, `${execution.stdout}\n${execution.stderr}`);
    const { receipt } = readBundle(resultPath);
    assert.strictEqual(receipt.outcome, 'cancelled');
    assert.strictEqual(receipt.terminalOwner, 'controller');
  });

  it('preserves legacy SIGTERM behavior without a result contract', async function () {
    const env = environment();
    const execution = await runUntilSignal(
      env,
      [
        'run',
        'Exercise legacy foreground termination',
        '--no-isolation',
        '--config',
        CONFIG_PATH,
        '--sim',
        'off',
      ],
      { FAKE_AGENT_SCENARIO: scenarioPath('single-worker-success-delayed') },
      'TASK_ID_ASSIGNED'
    );

    assert.strictEqual(execution.status, null, execution.stderr);
    assert.strictEqual(execution.signal, 'SIGTERM');
  });
});
