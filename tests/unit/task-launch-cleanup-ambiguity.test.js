const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runFixture(mode) {
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
    it(`${mode} retains the overlay after an exit-0 task-id parse failure until kill`, function () {
      const result = runFixture(mode);
      assert.match(result.rejection.message, /Could not parse task ID/);
      assert.strictEqual(result.rejection.commandCleanupOwner, 'task-lifecycle');
      assert.strictEqual(result.pending.status, 'running');
      assert.notStrictEqual(result.pending.commandCleanup, null);
      assert.strictEqual(result.overlayExistsAfterReject, true);
      assert.strictEqual(result.providerAliveAfterReject, true);
      assert.strictEqual(result.terminal.status, 'killed');
      assert.strictEqual(result.terminal.commandCleanup, null);
      assert.strictEqual(result.overlayExistsAfterKill, false);
      assert.strictEqual(result.providerAliveAfterKill, false);
    });
  }
});
