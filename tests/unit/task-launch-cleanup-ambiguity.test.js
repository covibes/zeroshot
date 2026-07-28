const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runFixture(mode, scenario = 'persisted') {
  const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-ambiguous-${mode}-`));
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.resolve(__dirname, '../fixtures/ambiguous-task-launch-runtime.js'), mode],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: taskHome,
          USERPROFILE: taskHome,
          ZEROSHOT_HOME: taskHome,
          AMBIGUOUS_TASK_SCENARIO: scenario,
          AMBIGUOUS_SETTINGS_MARKER: path.join(taskHome, 'settings-path'),
        },
        timeout: 30000,
      }
    );
    const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT:'));
    assert.ok(resultLine, stdout);
    return JSON.parse(resultLine.slice('RESULT:'.length));
  } finally {
    fs.rmSync(taskHome, { recursive: true, force: true });
  }
}

describe('Ambiguous task-wrapper cleanup ownership', function () {
  this.timeout(40000);

  for (const mode of ['runner', 'agent']) {
    it(`${mode} recovers cleanup after a durable task receipt`, function () {
      const result = runFixture(mode);
      assert.match(result.rejection.message, /failed with code 1/);
      assert.strictEqual(result.rejection.commandCleanupOwner, 'task-lifecycle');
      assert.strictEqual(result.pending.status, 'killed');
      assert.strictEqual(result.pending.commandCleanup, null);
      assert.strictEqual(result.overlayExistsAfterReject, false);
      assert.strictEqual(result.providerAliveAfterReject, false);
      assert.strictEqual(result.terminal.status, 'killed');
      assert.strictEqual(result.terminal.commandCleanup, null);
      assert.strictEqual(result.overlayExistsAfterKill, false);
      assert.strictEqual(result.providerAliveAfterKill, false);
    });

    it(`${mode} retains caller cleanup for a pre-persistence provider-contract failure`, function () {
      const result = runFixture(mode, 'pre-persistence-contract-failure');
      assert.match(result.rejection.message, /Upgrade Claude Code/);
      assert.strictEqual(result.rejection.commandCleanupOwner, undefined);
      assert.strictEqual(result.pending, null);
      assert.strictEqual(result.overlayExistsAfterReject, false);
    });

    it(`${mode} rejects legacy success output without a durable token receipt`, function () {
      const result = runFixture(mode, 'legacy-success-no-token');
      assert.match(result.rejection.message, /ownership receipt was not persisted/);
      assert.strictEqual(result.rejection.commandCleanupOwner, undefined);
      assert.strictEqual(result.pending, null);
      assert.strictEqual(result.overlayExistsAfterReject, false);
    });
  }
});

describe('Durable task ownership receipt', function () {
  it('returns the persisted task id without relying on human wrapper stdout', function () {
    const { requireTaskIdFromWrapperResult } = require('../../src/task-spawn-cleanup-ownership');
    assert.strictEqual(
      requireTaskIdFromWrapperResult({
        code: 0,
        stdout: 'human output changed',
        stderr: '',
        parseTaskId: () => null,
        persistedTaskId: 'task-durable-receipt',
      }),
      'task-durable-receipt'
    );
  });

  it('rejects wrapper output that disagrees with the durable receipt', function () {
    const { requireTaskIdFromWrapperResult } = require('../../src/task-spawn-cleanup-ownership');
    assert.throws(
      () =>
        requireTaskIdFromWrapperResult({
          code: 0,
          stdout: 'Task spawned: task-wrong-id',
          stderr: '',
          parseTaskId: () => 'task-wrong-id',
          persistedTaskId: 'task-durable-receipt',
        }),
      /did not match wrapper output/
    );
  });
});
