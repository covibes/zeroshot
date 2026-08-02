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
    assert.strictEqual(
      execution.status,
      ['unsafe', 'unsafe-file', 'clean-unsafe', 'clean-running'].includes(mode) ? 1 : 0,
      execution.stderr || execution.stdout
    );
    const { stdout } = execution;
    const resultLine = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
    assert.ok(resultLine, execution.stderr || stdout);
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

  it('retains an unsafe output-schema file receipt without touching the terminal task pid', function () {
    const { result, stdout } = runFixture('unsafe-file');
    assert.strictEqual(result.terminal.status, 'completed');
    assert.notStrictEqual(result.terminal.commandCleanup, null);
    assert.strictEqual(result.unrelatedAlive, true);
    assert.strictEqual(result.userFileExists, true);
    assert.match(stdout, /cleanup remains pending/i);
    assert.match(stdout, /Refusing (?:unowned|non-canonical) output-schema cleanup/);
  });
  for (const cleanMode of ['completed', 'failed', 'all']) {
    it(`recovers cleanup before deleting rows selected by --${cleanMode}`, function () {
      const { result } = runFixture(`clean-${cleanMode}`);
      assert.strictEqual(result.retained, null);
      assert.strictEqual(result.cleanupExists, false);
      assert.strictEqual(result.exitCode, 0);
    });
  }

  it('retains a selected row when clean cannot recover its receipt', function () {
    const { result, stdout } = runFixture('clean-unsafe');
    assert.notStrictEqual(result.retained, null);
    assert.notStrictEqual(result.retained.commandCleanup, null);
    assert.strictEqual(result.cleanupExists, true);
    assert.strictEqual(result.exitCode, 1);
    assert.match(stdout, /Retained: clean-all-unsafe/);
  });
  it('retains a running row and live overlay selected by --all', function () {
    // The live-task boundary is now evaluated before *any* cleanup side effect rather than inside
    // the command-cleanup branch, so the retention reason is the task being live — which is also
    // what protects a running task that carries no cleanup receipt at all (its OMP session
    // partition used to be staged and recursively deleted before this check was ever reached; see
    // tests/unit/omp-session-cleanup.test.js).
    const { result, stdout } = runFixture('clean-running');
    assert.strictEqual(result.retained.status, 'running');
    assert.notStrictEqual(result.retained.commandCleanup, null);
    assert.strictEqual(result.cleanupExists, true);
    assert.strictEqual(result.exitCode, 1);
    assert.match(stdout, /Retained: clean-all-running \[running\] \(running\)/);
  });
});
