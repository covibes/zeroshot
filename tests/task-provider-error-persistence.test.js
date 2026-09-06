const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTaskInspection } = require('../cli/commands/inspect');

const fixture = path.resolve(__dirname, 'fixtures/fake-task-provider-error.js');
const watcher = path.resolve(__dirname, '../task-lib/watcher.js');
const rawSecret = 'opaque-provider-credential-value';

const cases = [
  { provider: 'claude', disposition: 'permanent', needle: 'invalid_api_key' },
  { provider: 'codex', disposition: 'retryable', needle: 'rate_limit_exceeded' },
  { provider: 'gemini', disposition: 'permanent', needle: 'UNSUPPORTED_CLIENT' },
];

function waitForWatcher(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

describe('standalone task provider error persistence', function () {
  this.timeout(20000);

  let store;
  let getStatusData;
  let logDirectory;

  before(async function () {
    store = await import('../task-lib/store.js');
    ({ getStatusData } = await import('../task-lib/commands/status.js'));
    logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-errors-'));
  });

  after(function () {
    fs.rmSync(logDirectory, { recursive: true, force: true });
  });

  for (const { provider, disposition, needle } of cases) {
    for (const channel of ['stderr', 'stdout']) {
      it(`persists a redacted ${provider} ${channel} failure in SQLite and status surfaces`, async function () {
        const taskId = `provider-error-${provider}-${channel}-${randomUUID()}`;
        const logFile = path.join(logDirectory, `${taskId}.log`);
        store.addTask({
          id: taskId,
          prompt: 'fake provider failure',
          fullPrompt: 'fake provider failure',
          cwd: process.cwd(),
          status: 'running',
          pid: null,
          logFile,
          exitCode: null,
          error: null,
          provider,
          model: 'fake',
          attachable: false,
        });

        try {
          const config = {
            provider,
            outputFormat: 'text',
            commandSpec: {
              binary: process.execPath,
              args: [fixture, provider, channel],
              env: {},
              cleanup: [],
            },
          };
          const child = spawn(
            process.execPath,
            [watcher, taskId, process.cwd(), logFile, '[]', JSON.stringify(config)],
            { stdio: ['ignore', 'ignore', 'pipe'] }
          );
          const watcherResult = await waitForWatcher(child);
          assert.deepStrictEqual(watcherResult, { code: 0, signal: null, stderr: '' });

          const task = store.getTask(taskId);
          assert.strictEqual(task.status, 'failed');
          assert.strictEqual(task.exitCode, 1);
          assert(task.error.startsWith(`Provider ${provider} exited with code 1`));
          assert(task.error.includes(`(${disposition};`));
          assert(task.error.toLowerCase().includes(needle.toLowerCase()));
          assert(!task.error.includes(rawSecret));
          assert(Buffer.byteLength(task.error) <= 4096);

          const status = getStatusData(taskId);
          assert.strictEqual(status.error, task.error);
          const inspection = await buildTaskInspection(
            taskId,
            { sampleMs: 1 },
            { getTask: store.getTask, existsSync: fs.existsSync }
          );
          assert.strictEqual(inspection.task.error, task.error);

          const rawLog = fs.readFileSync(logFile, 'utf8');
          assert(rawLog.toLowerCase().includes(needle.toLowerCase()));
          assert(rawLog.includes(rawSecret));
        } finally {
          store.removeTask(taskId);
        }
      });
    }
  }

  it('redacts common credential assignments and Basic auth without removing ordinary fields', async function () {
    const taskId = `provider-error-assignments-${randomUUID()}`;
    const logFile = path.join(logDirectory, `${taskId}.log`);
    const secrets = [
      'opaque-token-value',
      'opaque-github-token-value',
      'opaque openrouter key value',
      'opaque-signature-value',
      'dXNlcjpwYXNzd29yZA==',
    ];
    store.addTask({
      id: taskId,
      prompt: 'fake provider credential assignments',
      fullPrompt: 'fake provider credential assignments',
      cwd: process.cwd(),
      status: 'running',
      pid: null,
      logFile,
      exitCode: null,
      error: null,
      provider: 'codex',
      model: 'fake',
      attachable: false,
    });

    try {
      const config = {
        provider: 'codex',
        outputFormat: 'text',
        commandSpec: {
          binary: process.execPath,
          args: [fixture, 'codex', 'stderr', 'credential-assignments'],
          env: {},
          cleanup: [],
        },
      };
      const child = spawn(
        process.execPath,
        [watcher, taskId, process.cwd(), logFile, '[]', JSON.stringify(config)],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      const watcherResult = await waitForWatcher(child);
      assert.deepStrictEqual(watcherResult, { code: 0, signal: null, stderr: '' });

      const task = store.getTask(taskId);
      assert.strictEqual(task.status, 'failed');
      for (const secret of secrets) {
        assert(!task.error.includes(secret), `persisted task error retained ${secret}`);
      }
      assert(task.error.includes('token_count=42'));
      assert(task.error.includes('signature_algorithm=ed25519'));
      assert(task.error.includes('authorization_status=initialized'));
      assert(task.error.includes('basic_mode=enabled'));

      const status = getStatusData(taskId);
      assert.strictEqual(status.error, task.error);
      const rawLog = fs.readFileSync(logFile, 'utf8');
      for (const secret of secrets) assert(rawLog.includes(secret));
    } finally {
      store.removeTask(taskId);
    }
  });

  for (const { scenario, secret, ordinary } of [
    {
      scenario: 'unterminated-assignment',
      secret: 'unterminated assignment secret with spaces',
      ordinary: 'ordinary_status=visible',
    },
    {
      scenario: 'unterminated-assignment-single',
      secret: 'unterminated single assignment secret with spaces',
      ordinary: 'phase=ready',
    },
    {
      scenario: 'unterminated-basic',
      secret: 'unterminated basic secret with spaces',
      ordinary: 'phase=ready',
    },
    {
      scenario: 'unterminated-basic-single',
      secret: 'unterminated single basic secret with spaces',
      ordinary: 'ordinary_status=visible',
    },
  ]) {
    it(`fails closed for ${scenario} output persisted through SQLite`, async function () {
      const taskId = `provider-error-${scenario}-${randomUUID()}`;
      const logFile = path.join(logDirectory, `${taskId}.log`);
      store.addTask({
        id: taskId,
        prompt: 'fake truncated provider credential',
        fullPrompt: 'fake truncated provider credential',
        cwd: process.cwd(),
        status: 'running',
        pid: null,
        logFile,
        exitCode: null,
        error: null,
        provider: 'codex',
        model: 'fake',
        attachable: false,
      });

      try {
        const config = {
          provider: 'codex',
          outputFormat: 'text',
          commandSpec: {
            binary: process.execPath,
            args: [fixture, 'codex', 'stderr', scenario],
            env: {},
            cleanup: [],
          },
        };
        const child = spawn(
          process.execPath,
          [watcher, taskId, process.cwd(), logFile, '[]', JSON.stringify(config)],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        const watcherResult = await waitForWatcher(child);
        assert.deepStrictEqual(watcherResult, { code: 0, signal: null, stderr: '' });

        const task = store.getTask(taskId);
        assert.strictEqual(task.status, 'failed');
        assert(!task.error.includes(secret));
        assert(task.error.includes('[REDACTED]'));

        const rawLog = fs.readFileSync(logFile, 'utf8');
        assert(rawLog.includes(secret));
        assert(rawLog.includes(ordinary));
      } finally {
        store.removeTask(taskId);
      }
    });
  }
});
