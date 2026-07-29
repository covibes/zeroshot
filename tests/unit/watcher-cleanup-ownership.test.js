const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('watcher command cleanup ownership', function () {
  this.timeout(40000);

  async function runFixture(watcherName, mode) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-watcher-home-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.resolve(__dirname, '../fixtures/watcher-cleanup-runtime.js'), watcherName, mode],
        {
          env: { ...process.env, HOME: tempHome, ZEROSHOT_HOME: tempHome },
          timeout: 30000,
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      assert.ok(line, stdout);
      return JSON.parse(line.slice('RESULT:'.length));
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }

  for (const watcherName of ['watcher.js', 'attachable-watcher.js']) {
    it(`${watcherName} terminates its provider before crash cleanup`, async function () {
      const result = await runFixture(watcherName, 'crash');
      assert.strictEqual(result.watcherExit.code, 1, result.watcherOutput);
      assert.strictEqual(result.providerAlive, false);
      assert.strictEqual(result.cleanupExists, false);
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.commandCleanup, null);
      assert.match(result.watcherOutput, /\[CRASH\]/);
    });
  }

  for (const watcherName of ['watcher.js', 'attachable-watcher.js']) {
    it(`${watcherName} honors cancellation before provider spawn`, async function () {
      const result = await runFixture(watcherName, 'cancel-before-start');
      assert.strictEqual(result.watcherExit.code, 0, result.watcherOutput);
      assert.strictEqual(result.providerPid, null);
      assert.strictEqual(result.providerAlive, false);
      assert.strictEqual(result.cleanupExists, false);
      assert.strictEqual(result.status, 'killed');
      assert.strictEqual(result.cancelRequested, false);
      assert.strictEqual(result.commandCleanup, null);
    });
  }

  for (const watcherName of ['watcher.js', 'attachable-watcher.js']) {
    it(`${watcherName} retains ownership when a Windows process-tree root is gone`, async function () {
      const runtime = await import('../../task-lib/watcher-output-runtime.js');
      const receipt = { cleanup: ['owned-overlay'], cleanupMetadata: [] };
      const task = {
        status: 'running',
        pid: 424242,
        processGroupId: null,
        commandCleanup: receipt,
      };
      let cleanupRuns = 0;
      const completionOptions = {
        taskId: `win-root-gone-${watcherName}`,
        commandCleanup: {
          run() {
            cleanupRuns++;
            return Promise.resolve(true);
          },
        },
        terminateProvider: () =>
          runtime.terminateWatcherProvider(
            { pid: task.pid },
            {
              platform: 'win32',
              terminateProcessFn: () =>
                Promise.resolve({
                  terminated: true,
                  alreadyDead: true,
                  scope: 'process-tree',
                }),
            }
          ),
        updateTask: (_taskId, updates) => Promise.resolve(Object.assign(task, updates)),
        emergencyLog() {},
      };

      const completed =
        watcherName === 'watcher.js'
          ? await runtime.completeWatcherTask({
              ...completionOptions,
              completion: { status: 'completed', resolvedCode: 0, error: null },
            })
          : await runtime.completeWatcherFailure({
              ...completionOptions,
              error: new Error('simulated attachable watcher failure'),
              source: 'uncaughtException',
            });

      assert.strictEqual(completed, false);
      assert.strictEqual(task.status, 'running');
      assert.strictEqual(task.pid, 424242);
      assert.strictEqual(task.commandCleanup, receipt);
      assert.strictEqual(cleanupRuns, 0);

      task.status = 'running';
      task.pid = 424242;
      task.commandCleanup = receipt;
      completionOptions.terminateProvider = () =>
        runtime.terminateWatcherProvider(
          { pid: task.pid },
          {
            platform: 'win32',
            exitObserved: true,
            terminateProcessFn: () =>
              Promise.resolve({
                terminated: true,
                alreadyDead: true,
                scope: 'process-tree',
              }),
          }
        );
      const observedCompletion =
        watcherName === 'watcher.js'
          ? await runtime.completeWatcherTask({
              ...completionOptions,
              completion: { status: 'completed', resolvedCode: 0, error: null },
            })
          : await runtime.completeWatcherFailure({
              ...completionOptions,
              error: new Error('simulated attachable watcher failure'),
              source: 'uncaughtException',
            });
      assert.strictEqual(observedCompletion, true);
      assert.notStrictEqual(task.status, 'running');
      assert.strictEqual(task.pid, null);
      assert.strictEqual(task.commandCleanup, null);
      assert.strictEqual(cleanupRuns, 1);
    });
  }

  it('fails durably when the provider executable disappears before spawn', async function () {
    const result = await runFixture('watcher.js', 'missing-command');
    assert.strictEqual(result.watcherExit.code, 1, result.watcherOutput);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.commandCleanup, null);
    assert.strictEqual(result.cleanupExists, false);
    assert.match(result.logOutput, /ENOENT|no such file/i);
  });

  it('cleans an owned overlay after normal completion', async function () {
    const result = await runFixture('watcher.js', 'exit0');
    assert.strictEqual(result.watcherExit.code, 0);
    assert.strictEqual(result.cleanupExists, false);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.commandCleanup, null);
  });

  it('cleans an owned overlay after provider failure while preserving provider exit truth', async function () {
    const result = await runFixture('watcher.js', 'exit7');
    assert.strictEqual(result.watcherExit.code, 0);
    assert.strictEqual(result.cleanupExists, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.exitCode, 7);
    assert.match(result.logOutput, /Exit code: 7/);
  });

  it('refuses recursive cleanup for an unrelated directory', async function () {
    const result = await runFixture('watcher.js', 'unowned');
    assert.strictEqual(result.cleanupExists, true);
    assert.strictEqual(result.ownedOverlayExists, true);
    assert.notStrictEqual(result.commandCleanup, null);
  });

  it('attachable-watcher loads and runs persisted cleanup after an early args failure', async function () {
    const result = await runFixture('attachable-watcher.js', 'invalid-args');
    assert.strictEqual(result.watcherExit.code, 1, result.watcherOutput);
    assert.strictEqual(result.cleanupExists, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.commandCleanup, null);
    assert.match(result.logOutput, /\[CRASH\]/);
  });

  it('attachable-watcher retains an unsafe persisted receipt after an early args failure', async function () {
    const result = await runFixture('attachable-watcher.js', 'invalid-args-unowned');
    assert.strictEqual(result.watcherExit.code, 1, result.watcherOutput);
    assert.strictEqual(result.cleanupExists, true);
    assert.strictEqual(result.status, 'failed');
    assert.notStrictEqual(result.commandCleanup, null);
    assert.match(result.logOutput, /Refusing unowned temporary directory cleanup/);
  });
});
