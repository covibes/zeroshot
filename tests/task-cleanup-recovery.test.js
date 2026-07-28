const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const commandCleanupFixtureSource = `
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const overlayRoot = path.join(os.tmpdir(), 'zeroshot-claude-settings');
  fs.mkdirSync(overlayRoot, { recursive: true });
  const liveCleanup = fs.mkdtempSync(path.join(overlayRoot, 'run-kill-live-'));
  const deadCleanup = fs.mkdtempSync(path.join(overlayRoot, 'run-kill-dead-'));
  const cleanupMetadata = (cleanupPath) => [{
    kind: 'temp-directory', provider: 'claude',
    path: cleanupPath, reason: 'settings-overlay'
  }];
`;

describe('Task cleanup recovery', function () {
  this.timeout(40000);

  it('cleans persisted resources for killed and already-dead tasks', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-kill-store-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const resistantScript = path.resolve(__dirname, 'fixtures/sigterm-resistant-process.js');
    const script = `
      import { spawn } from 'child_process';
      ${commandCleanupFixtureSource}
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      const base = {
        prompt: 'hang', fullPrompt: 'hang', cwd: process.cwd(), status: 'running',
        sessionId: null, logFile: null, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), exitCode: null, error: null,
        provider: 'codex', model: 'fake', scheduleId: null, socketPath: null,
        attachable: false, processGroupId: null, terminationStrategy: null
      };
      const child = spawn(process.execPath, [${JSON.stringify(resistantScript)}], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      addTask({
        ...base,
        id: 'live-task',
        pid: child.pid,
        processGroupId: process.platform === 'win32' ? null : child.pid,
        terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
        commandCleanup: {
          cleanup: [liveCleanup],
          cleanupMetadata: cleanupMetadata(liveCleanup)
        }
      });
      await killTaskCommand('live-task', { graceMs: 40, pollMs: 5 });
      addTask({
        ...base,
        id: 'dead-task',
        pid: 99999999,
        commandCleanup: {
          cleanup: [deadCleanup],
          cleanupMetadata: cleanupMetadata(deadCleanup)
        }
      });
      await killTaskCommand('dead-task', { graceMs: 40, pollMs: 5 });
      console.log('RESULT:' + JSON.stringify({
        live: getTask('live-task'),
        dead: getTask('dead-task'),
        liveCleanupExists: fs.existsSync(liveCleanup),
        deadCleanupExists: fs.existsSync(deadCleanup)
      }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: taskHome,
            USERPROFILE: taskHome,
            ZEROSHOT_HOME: taskHome,
          },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const terminal = JSON.parse(line.slice('RESULT:'.length));
      assert.deepStrictEqual(
        [
          terminal.live.status,
          terminal.live.pid,
          terminal.live.processGroupId,
          terminal.dead.status,
          terminal.dead.pid,
        ],
        ['killed', null, null, 'stale', null]
      );
      assert.match(terminal.live.error, /SIGKILL/);
      assert.strictEqual(terminal.live.commandCleanup, null);
      assert.strictEqual(terminal.dead.commandCleanup, null);
      assert.strictEqual(terminal.liveCleanupExists, false);
      assert.strictEqual(terminal.deadCleanupExists, false);
    } finally {
      fs.rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('persists cancellation and cleanup ownership when the watcher fails before publishing a PID', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-starting-store-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const script = `
      import fs from 'fs';
      import os from 'os';
      import path from 'path';
      const overlayRoot = path.join(os.tmpdir(), 'zeroshot-claude-settings');
      fs.mkdirSync(overlayRoot, { recursive: true });
      const startingCleanup = fs.mkdtempSync(path.join(overlayRoot, 'run-kill-starting-'));
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      addTask({
        id: 'starting-task',
        status: 'running',
        pid: null,
        commandCleanup: {
          cleanup: [startingCleanup],
          cleanupMetadata: [{
            kind: 'temp-directory',
            provider: 'claude',
            path: startingCleanup,
            reason: 'settings-overlay'
          }]
        }
      });
      await killTaskCommand('starting-task', { startupCancelTimeoutMs: 40, pollMs: 5 });
      const task = getTask('starting-task');
      const cleanupExists = fs.existsSync(startingCleanup);
      const exitCode = process.exitCode || 0;
      process.exitCode = 0;
      fs.rmSync(startingCleanup, { recursive: true, force: true });
      console.log('RESULT:' + JSON.stringify({ task, cleanupExists, exitCode }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: taskHome,
            USERPROFILE: taskHome,
            ZEROSHOT_HOME: taskHome,
          },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const result = JSON.parse(line.slice('RESULT:'.length));
      assert.strictEqual(result.task.status, 'running');
      assert.strictEqual(result.task.pid, null);
      assert.notStrictEqual(result.task.commandCleanup, null);
      assert.strictEqual(result.task.cancelRequested, true);
      assert.strictEqual(result.cleanupExists, true);
      assert.strictEqual(result.exitCode, 1);
    } finally {
      fs.rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('honors persisted cancellation after a late provider PID is published', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-late-pid-store-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const runtimeUrl = new URL('../task-lib/watcher-output-runtime.js', `file://${__filename}`)
      .href;
    const cleanupUrl = new URL('../task-lib/command-spec-cleanup.js', `file://${__filename}`)
      .href;
    const terminationUrl = new URL('../task-lib/process-termination.js', `file://${__filename}`)
      .href;
    const script = `
      import { spawn } from 'child_process';
      ${commandCleanupFixtureSource}
      const { addTask, getTask, updateTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      const { completePendingWatcherCancellation } = await import(${JSON.stringify(runtimeUrl)});
      const { createCommandSpecCleanup } = await import(${JSON.stringify(cleanupUrl)});
      const { terminateProcess } = await import(${JSON.stringify(terminationUrl)});
      addTask({
        id: 'late-pid-task',
        status: 'running',
        pid: null,
        commandCleanup: {
          cleanup: [liveCleanup],
          cleanupMetadata: cleanupMetadata(liveCleanup)
        }
      });
      const cancellation = killTaskCommand('late-pid-task', {
        startupCancelTimeoutMs: 2000,
        pollMs: 5
      });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32',
        stdio: 'ignore'
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      updateTask('late-pid-task', {
        pid: child.pid,
        processGroupId: process.platform === 'win32' ? null : child.pid,
        terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group'
      });
      const commandCleanup = createCommandSpecCleanup(
        getTask('late-pid-task').commandCleanup,
        () => {}
      );
      await completePendingWatcherCancellation({
        taskId: 'late-pid-task',
        getTask,
        commandCleanup,
        terminateProvider: () => terminateProcess(child.pid, {
          processGroupId: process.platform === 'win32' ? null : child.pid,
          terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
          graceMs: 100,
          pollMs: 5
        }).then((result) => result.terminated),
        updateTask,
        emergencyLog() {}
      });
      await cancellation;
      const terminal = getTask('late-pid-task');
      let providerAlive = true;
      try { process.kill(child.pid, 0); } catch { providerAlive = false; }
      console.log('RESULT:' + JSON.stringify({
        terminal,
        cleanupExists: fs.existsSync(liveCleanup),
        providerAlive,
        exitCode: process.exitCode || 0
      }));
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      fs.rmSync(deadCleanup, { recursive: true, force: true });
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: taskHome,
            USERPROFILE: taskHome,
            ZEROSHOT_HOME: taskHome,
          },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const result = JSON.parse(line.slice('RESULT:'.length));
      assert.strictEqual(result.terminal.status, 'killed');
      assert.strictEqual(result.terminal.cancelRequested, false);
      assert.strictEqual(result.terminal.commandCleanup, null);
      assert.strictEqual(result.cleanupExists, false);
      assert.strictEqual(result.providerAlive, false);
      assert.strictEqual(result.exitCode, 0);
    } finally {
      fs.rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('returns failure while terminal cleanup remains and succeeds on retry', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-cleanup-retry-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const script = `
      import fs from 'fs';
      import os from 'os';
      import path from 'path';
      const overlayRoot = path.join(os.tmpdir(), 'zeroshot-claude-settings');
      fs.mkdirSync(overlayRoot, { recursive: true });
      const cleanupPath = path.join(overlayRoot, 'run-transient-cleanup-retry');
      fs.rmSync(cleanupPath, { recursive: true, force: true });
      fs.mkdirSync(cleanupPath);
      const { addTask, getTask, updateTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      addTask({
        id: 'terminal-cleanup-retry',
        status: 'failed',
        pid: null,
        commandCleanup: {
          cleanup: [cleanupPath],
          cleanupMetadata: [{
            kind: 'temp-directory',
            provider: 'codex',
            path: cleanupPath,
            reason: 'settings-overlay'
          }]
        }
      });
      await killTaskCommand('terminal-cleanup-retry');
      const first = {
        exitCode: process.exitCode || 0,
        receiptPending: Boolean(getTask('terminal-cleanup-retry').commandCleanup)
      };
      updateTask('terminal-cleanup-retry', {
        commandCleanup: {
          cleanup: [cleanupPath],
          cleanupMetadata: [{
            kind: 'temp-directory',
            provider: 'claude',
            path: cleanupPath,
            reason: 'settings-overlay'
          }]
        }
      });
      process.exitCode = 0;
      await killTaskCommand('terminal-cleanup-retry');
      const second = {
        exitCode: process.exitCode || 0,
        receiptPending: Boolean(getTask('terminal-cleanup-retry').commandCleanup),
        cleanupExists: fs.existsSync(cleanupPath)
      };
      console.log('RESULT:' + JSON.stringify({ first, second }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: taskHome,
            USERPROFILE: taskHome,
            ZEROSHOT_HOME: taskHome,
          },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const result = JSON.parse(line.slice('RESULT:'.length));
      assert.deepStrictEqual(result.first, { exitCode: 1, receiptPending: true });
      assert.deepStrictEqual(result.second, {
        exitCode: 0,
        receiptPending: false,
        cleanupExists: false,
      });
    } finally {
      fs.rmSync(taskHome, { recursive: true, force: true });
    }
  });
});

describe('Task cleanup after deferred termination', function () {
  this.timeout(40000);

  it('preserves live ownership after watcher termination fails and allows a later kill', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-termination-pending-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const runtimeUrl = new URL('../task-lib/watcher-output-runtime.js', `file://${__filename}`)
      .href;
    const resistantScript = path.resolve(__dirname, 'fixtures/sigterm-resistant-process.js');
    const script = `
      import { spawn } from 'child_process';
      ${commandCleanupFixtureSource}
      const { addTask, getTask, updateTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      const { completeWatcherTask } = await import(${JSON.stringify(runtimeUrl)});
      const child = spawn(process.execPath, [${JSON.stringify(resistantScript)}], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      addTask({
        id: 'termination-pending',
        prompt: 'hang',
        fullPrompt: 'hang',
        cwd: process.cwd(),
        status: 'running',
        pid: child.pid,
        processGroupId: process.platform === 'win32' ? null : child.pid,
        terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
        commandCleanup: {
          cleanup: [liveCleanup],
          cleanupMetadata: cleanupMetadata(liveCleanup)
        }
      });
      let cleanupRuns = 0;
      await completeWatcherTask({
        taskId: 'termination-pending',
        completion: { status: 'failed', resolvedCode: 1, error: 'watcher crashed' },
        commandCleanup: { async run() { cleanupRuns += 1; return true; } },
        terminateProvider: async () => false,
        updateTask,
        emergencyLog() {}
      });
      const pending = getTask('termination-pending');
      const cleanupExistsWhilePending = fs.existsSync(liveCleanup);
      await killTaskCommand('termination-pending', { graceMs: 40, pollMs: 5 });
      const killed = getTask('termination-pending');
      console.log('RESULT:' + JSON.stringify({
        providerPid: child.pid,
        pending,
        killed,
        cleanupRuns,
        cleanupExistsWhilePending,
        cleanupExistsAfterKill: fs.existsSync(liveCleanup)
      }));
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: taskHome,
            USERPROFILE: taskHome,
            ZEROSHOT_HOME: taskHome,
          },
        }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
      const result = JSON.parse(line.slice('RESULT:'.length));
      assert.strictEqual(result.pending.status, 'running');
      assert.strictEqual(result.pending.pid, result.providerPid);
      assert.strictEqual(
        result.pending.processGroupId,
        process.platform === 'win32' ? null : result.providerPid
      );
      assert.strictEqual(
        result.pending.terminationStrategy,
        process.platform === 'win32' ? 'process-tree' : 'process-group'
      );
      assert.notStrictEqual(result.pending.commandCleanup, null);
      assert.strictEqual(result.cleanupRuns, 0);
      assert.strictEqual(result.cleanupExistsWhilePending, true);
      assert.strictEqual(result.killed.status, 'killed');
      assert.strictEqual(result.killed.pid, null);
      assert.strictEqual(result.killed.processGroupId, null);
      assert.strictEqual(result.killed.commandCleanup, null);
      assert.strictEqual(result.cleanupExistsAfterKill, false);
    } finally {
      fs.rmSync(taskHome, { recursive: true, force: true });
    }
  });
});
