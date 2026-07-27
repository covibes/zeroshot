const assert = require('node:assert');
const childProcess = require('node:child_process');
const filesystem = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

function runFixture(mode) {
  const taskHome = filesystem.mkdtempSync(join(tmpdir(), `zeroshot-terminal-${mode}-`));
  try {
    const execution = childProcess.spawnSync(
      process.execPath,
      [resolve(__dirname, 'fixtures/task-terminal-cleanup-runtime.js'), mode],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: taskHome,
          USERPROFILE: taskHome,
          ZEROSHOT_HOME: taskHome,
        },
      }
    );
    assert.strictEqual(execution.status, 0, execution.stderr || execution.stdout);
    const { stdout } = execution;
    const resultLine = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
    assert.ok(resultLine, stdout);
    return {
      stdout,
      result: JSON.parse(resultLine.slice('RESULT:'.length)),
    };
  } finally {
    filesystem.rmSync(taskHome, { recursive: true, force: true });
  }
}

describe('Terminal task cleanup recovery', function () {
  this.timeout(40000);

  it('retries a watcher cleanup receipt after the task becomes terminal', function () {
    const { result } = runFixture('retry');
    assert.strictEqual(result.terminal.status, 'completed');
    assert.strictEqual(result.terminal.pid, null);
    assert.notStrictEqual(result.terminal.commandCleanup, null);
    assert.strictEqual(result.cleanupRuns, 1);
    assert.strictEqual(result.cleanupExistsBeforeRetry, true);
    assert.strictEqual(result.recovered.status, 'completed');
    assert.strictEqual(result.recovered.commandCleanup, null);
    assert.strictEqual(result.cleanupExistsAfterRetry, false);
  });

  it('retains unsafe cleanup without terminating the terminal task pid', function () {
    const { result, stdout } = runFixture('unsafe');
    assert.strictEqual(result.terminal.status, 'completed');
    assert.notStrictEqual(result.terminal.commandCleanup, null);
    assert.strictEqual(result.unrelatedAlive, true);
    assert.strictEqual(result.userDirectoryExists, true);
    assert.match(stdout, /cleanup remains pending/i);
    assert.match(stdout, /Refusing unowned temporary directory cleanup/);
  });
});
