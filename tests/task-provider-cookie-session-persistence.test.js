const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { buildTaskInspection } = require('../cli/commands/inspect');

const execute = promisify(execFile);
const watcher = path.resolve(__dirname, '../task-lib/watcher.js');

describe('standalone task Cookie/session provider error persistence', function () {
  this.timeout(20000);

  it('sanitizes raw provider output before SQLite and inspection persistence', async function () {
    const store = await import('../task-lib/store.js');
    const { getStatusData } = await import('../task-lib/commands/status.js');
    const taskId = `provider-error-cookie-session-${randomUUID()}`;
    const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cookie-error-'));
    const logFile = path.join(logDirectory, `${taskId}.log`);
    const secrets = ['session-secret', 'session-id-secret', 'cookie-secret'];
    const rawDiagnostic =
      `rate_limit_exceeded retry_after=30 session=${secrets[0]} ` +
      `sessionId=${secrets[1]} Cookie: session=${secrets[2]}; theme=dark`;

    store.addTask({
      attachable: false,
      cwd: process.cwd(),
      error: null,
      exitCode: null,
      fullPrompt: 'fake provider cookie failure',
      id: taskId,
      logFile,
      model: 'fake',
      pid: null,
      prompt: 'fake provider cookie failure',
      provider: 'codex',
      status: 'running',
    });

    try {
      const config = {
        commandSpec: {
          args: [
            '-e',
            `process.stderr.write(${JSON.stringify(`${rawDiagnostic}\n`)});process.exit(1)`,
          ],
          binary: process.execPath,
          cleanup: [],
          env: {},
        },
        outputFormat: 'text',
        provider: 'codex',
      };
      await execute(process.execPath, [
        watcher,
        taskId,
        process.cwd(),
        logFile,
        '[]',
        JSON.stringify(config),
      ]);

      const task = store.getTask(taskId);
      const status = getStatusData(taskId);
      const inspection = await buildTaskInspection(
        taskId,
        { sampleMs: 1 },
        { existsSync: fs.existsSync, getTask: store.getTask }
      );
      for (const secret of secrets) {
        assert(!task.error.includes(secret));
        assert(!status.error.includes(secret));
        assert(!inspection.task.error.includes(secret));
        assert(fs.readFileSync(logFile, 'utf8').includes(secret));
      }
      assert(task.error.includes('rate_limit_exceeded'));
      assert(task.error.includes('retry_after=30'));
    } finally {
      store.removeTask(taskId);
      fs.rmSync(logDirectory, { force: true, recursive: true });
    }
  });
});
