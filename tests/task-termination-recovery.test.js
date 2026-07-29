const assert = require('assert');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('Task termination recovery', function () {
  this.timeout(40000);

  it('terminates the exact owned provider process group including descendants', async function () {
    const { isProcessRunning, terminateProcess } = await import('../task-lib/runner.js');
    const root = spawn(
      process.execPath,
      [path.resolve(__dirname, 'fixtures/sigterm-root-with-child.js')],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    const childPid = Number(
      String(await new Promise((resolve) => root.stdout.once('data', resolve))).trim()
    );

    try {
      const result = await terminateProcess(root.pid, {
        processGroupId: process.platform === 'win32' ? null : root.pid,
        terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
        graceMs: 200,
        hardKillWaitMs: 500,
        pollMs: 10,
      });

      assert.strictEqual(result.terminated, true);
      assert.strictEqual(isProcessRunning(root.pid), false);
      assert.strictEqual(isProcessRunning(childPid), false);
      assert.strictEqual(isProcessRunning(unrelated.pid), true);
    } finally {
      for (const pid of [root.pid, childPid, unrelated.pid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already terminated.
        }
      }
    }
  });

  it('escalates graceful provider termination to a hard kill', async function () {
    const { terminateProcess } = await import('../task-lib/runner.js');
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, 'fixtures/sigterm-resistant-process.js')],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    await new Promise((resolve) => child.stdout.once('data', resolve));

    try {
      const result = await terminateProcess(child.pid, { graceMs: 40, pollMs: 5 });
      assert.strictEqual(result.terminated, true);
      assert.strictEqual(result.signal, 'SIGKILL');
      assert.strictEqual(result.escalated, true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('Task ownership persistence and runtime wiring', function () {
  this.timeout(40000);

  it('round-trips owned process metadata through addTask', async function () {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-ownership-store-'));
    const storeUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/store.js')).href;
    const script = `
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      addTask({
        id: 'owned-task',
        status: 'running',
        pid: 4242,
        processGroupId: 4242,
        terminationStrategy: 'process-group',
        commandCleanup: {
          cleanup: ['/tmp/owned-cleanup'],
          cleanupMetadata: [{
            kind: 'temp-file',
            provider: 'codex',
            path: '/tmp/owned-cleanup',
            reason: 'output-schema'
          }]
        }
      });
      const task = getTask('owned-task');
      process.stdout.write(JSON.stringify({
        processGroupId: task.processGroupId,
        terminationStrategy: task.terminationStrategy,
        commandCleanup: task.commandCleanup
      }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: { ...process.env, HOME: tempHome },
        }
      );
      assert.deepStrictEqual(JSON.parse(stdout), {
        processGroupId: 4242,
        terminationStrategy: 'process-group',
        commandCleanup: {
          cleanup: ['/tmp/owned-cleanup'],
          cleanupMetadata: [
            {
              kind: 'temp-file',
              provider: 'codex',
              path: '/tmp/owned-cleanup',
              reason: 'output-schema',
            },
          ],
        },
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  for (const watcherName of ['watcher.js', 'attachable-watcher.js']) {
    it(`persists ${watcherName} ownership and kills its provider descendants`, async function () {
      const shortTmp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
      const tempHome = fs.mkdtempSync(path.join(shortTmp, 'zsw-'));
      const fixture = path.resolve(__dirname, 'fixtures/watcher-ownership-runtime.js');
      try {
        const { stdout } = await execFileAsync(process.execPath, [fixture, watcherName], {
          env: { ...process.env, HOME: tempHome },
          timeout: 30000,
        });
        const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
        const result = JSON.parse(line.slice('RESULT:'.length));
        assert.strictEqual(result.providerAlive, false);
        assert.strictEqual(result.descendantAlive, false);
        assert.strictEqual(result.unrelatedAlive, true);
        assert.strictEqual(result.terminalGroupId, null);
        assert.strictEqual(result.cleanupRemoved, true);
        assert.strictEqual(
          result.persistedStrategy,
          process.platform === 'win32' ? 'process-tree' : 'process-group'
        );
        if (process.platform !== 'win32') {
          assert.strictEqual(result.persistedGroupId, result.providerPid);
        }
      } finally {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    });
  }

  it('fails closed instead of crashing on corrupt ownership metadata', async function () {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-corrupt-ownership-'));
    const storeUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/store.js')).href;
    const killUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/commands/kill.js')).href;
    const statusUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/commands/status.js')).href;
    const script = `
      import { spawn } from 'child_process';
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      const { showStatus } = await import(${JSON.stringify(statusUrl)});
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      });
      addTask({
        id: 'corrupt-task',
        status: 'running',
        pid: child.pid,
        processGroupId: child.pid + 1,
        terminationStrategy: 'process-group'
      });
      let statusThrew = false;
      let killThrew = false;
      try { showStatus('corrupt-task'); } catch { statusThrew = true; }
      try { await killTaskCommand('corrupt-task'); } catch { killThrew = true; }
      const task = getTask('corrupt-task');
      let childAlive = true;
      try { process.kill(child.pid, 0); } catch { childAlive = false; }
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      const exitCode = process.exitCode || 0;
      process.exitCode = 0;
      process.stdout.write('\\nRESULT:' + JSON.stringify({
        statusThrew,
        killThrew,
        childAlive,
        status: task.status,
        pid: task.pid,
        exitCode
      }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: { ...process.env, HOME: tempHome },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const result = JSON.parse(line.slice('RESULT:'.length));
      assert.deepStrictEqual(result, {
        statusThrew: false,
        killThrew: false,
        childAlive: true,
        status: 'running',
        pid: result.pid,
        exitCode: 1,
      });
      assert.ok(Number.isInteger(result.pid));
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
