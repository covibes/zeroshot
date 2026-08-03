const assert = require('node:assert');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { followClaudeTaskLogs } = require('../src/agent/agent-task-executor');
const ClaudeTaskRunner = require('../src/claude-task-runner');
const { makeSessionPartition } = require('./helpers/omp-session-fixtures');
const commandCleanupFixtureSource = `
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const liveCleanup = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zeroshot-claude-settings-run-kill-live-')
  );
  const deadCleanup = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zeroshot-claude-settings-run-kill-dead-')
  );
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
      const startingCleanup = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroshot-claude-settings-run-kill-starting-')
      );
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
    const script = `
      import { spawn } from 'child_process';
      ${commandCleanupFixtureSource}
      const { addTask, getTask, updateTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
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
      while (!getTask('late-pid-task').cancelRequested) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
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

  it('preserves Windows process-tree cleanup ownership when the root is already gone', async function () {
    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-task-win-root-gone-'));
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const killUrl = new URL('../task-lib/commands/kill.js', `file://${__filename}`).href;
    const script = `
      ${commandCleanupFixtureSource}
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      const { killTaskCommand } = await import(${JSON.stringify(killUrl)});
      addTask({
        id: 'win-root-gone',
        status: 'running',
        pid: 424242,
        terminationStrategy: 'process-tree',
        commandCleanup: {
          cleanup: [liveCleanup],
          cleanupMetadata: cleanupMetadata(liveCleanup)
        }
      });
      await killTaskCommand('win-root-gone', {
        platform: 'win32',
        terminateProcessFn: async () => ({
          terminated: true,
          alreadyDead: true,
          scope: 'process-tree'
        })
      });
      const exitCode = process.exitCode || 0;
      process.exitCode = 0;
      console.log('RESULT:' + JSON.stringify({
        task: getTask('win-root-gone'),
        cleanupExists: fs.existsSync(liveCleanup),
        exitCode
      }));
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
      assert.strictEqual(result.task.status, 'running');
      assert.strictEqual(result.task.pid, 424242);
      assert.notStrictEqual(result.task.commandCleanup, null);
      assert.strictEqual(result.cleanupExists, true);
      assert.strictEqual(result.exitCode, 1);
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
      const cleanupPath = path.join(
        os.tmpdir(),
        'zeroshot-claude-settings-run-transient-cleanup-retry'
      );
      fs.rmSync(cleanupPath, { recursive: true, force: true });
      fs.mkdirSync(cleanupPath, { mode: 0o700 });
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

describe('Confirmed CLI task termination boundary', function () {
  this.timeout(40000);

  for (const command of ['kill-all', 'purge']) {
    it(`${command} waits for process exit before retiring OMP ownership`, async function () {
      if (process.platform === 'win32') this.skip();

      const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-${command}-boundary-`));
      const storageRoot = fs.mkdtempSync(path.join(taskHome, 'storage-'));
      const partition = makeSessionPartition({ storageRoot });
      const markerPath = path.join(taskHome, 'provider-after-signal.txt');
      const providerScript = path.join(taskHome, 'delayed-provider.cjs');
      const taskId = `${command}-confirmed-boundary`;
      const cliPath = path.resolve(__dirname, '../cli/index.js');
      const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
      const ownershipUrl = new URL('../task-lib/omp-session-ownership.js', `file://${__filename}`)
        .href;
      const env = {
        ...process.env,
        HOME: taskHome,
        USERPROFILE: taskHome,
        ZEROSHOT_HOME: taskHome,
      };

      fs.writeFileSync(
        providerScript,
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          'const [partitionPath, markerPath] = process.argv.slice(2);',
          'let stopping = false;',
          "process.on('SIGTERM', () => {",
          '  if (stopping) return;',
          '  stopping = true;',
          '  setTimeout(() => {',
          '    try {',
          "      fs.writeFileSync(path.join(partitionPath, 'late-provider-write.txt'), 'complete');",
          "      fs.writeFileSync(markerPath, 'write-ok');",
          '    } catch (error) {',
          "      fs.writeFileSync(markerPath, `write-failed:${error.code || 'unknown'}`);",
          '    }',
          '    process.exit(0);',
          '  }, 800);',
          '});',
          "process.stdout.write('READY\\n');",
          'setInterval(() => {}, 1000);',
        ].join('\n')
      );

      const child = spawn(process.execPath, [providerScript, partition.partitionPath, markerPath], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      try {
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.stdout.once('data', resolve);
        });
        await execFileAsync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
              const { addTask } = await import(${JSON.stringify(storeUrl)});
              const { writeProvisionalOwnership } =
                await import(${JSON.stringify(ownershipUrl)});
              addTask({
                id: ${JSON.stringify(taskId)},
                status: 'running',
                provider: 'omp',
                cwd: ${JSON.stringify(storageRoot)},
                pid: ${child.pid},
                processGroupId: ${child.pid},
                terminationStrategy: 'process-group',
                ompSessionOwnership: writeProvisionalOwnership({
                  partitionId: ${JSON.stringify(partition.partitionId)},
                  storageRoot: ${JSON.stringify(storageRoot)},
                  canonicalWorkspace: ${JSON.stringify(storageRoot)},
                  owner: {
                    kind: 'standalone',
                    clusterId: null,
                    agentId: null,
                    taskId: ${JSON.stringify(taskId)},
                  },
                }),
              });
            `,
          ],
          { env }
        );

        await execFileAsync(process.execPath, [cliPath, command, '--yes'], { env });

        assert.ok(
          fs.existsSync(markerPath),
          `${command} returned before the provider process exited`
        );
        assert.strictEqual(
          fs.readFileSync(markerPath, 'utf8'),
          'write-ok',
          `${command} deleted the partition while the provider was still writing`
        );

        const { stdout } = await execFileAsync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
              const { getTask } = await import(${JSON.stringify(storeUrl)});
              process.stdout.write(JSON.stringify(getTask(${JSON.stringify(taskId)}) ?? null));
            `,
          ],
          { env }
        );
        const task = JSON.parse(stdout);
        if (command === 'kill-all') {
          assert.strictEqual(task.status, 'killed');
          assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
          assert.ok(fs.existsSync(partition.partitionPath));
        } else {
          assert.strictEqual(task, null);
          assert.ok(!fs.existsSync(partition.partitionPath));
        }
      } finally {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The expected path already reaped the confirmed process group.
        }
        fs.rmSync(taskHome, { recursive: true, force: true });
      }
    });
  }

  it('purge aborts before cleanup when provider termination is unconfirmed', async function () {
    if (process.platform === 'win32') this.skip();

    const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-purge-unconfirmed-'));
    const storageRoot = fs.mkdtempSync(path.join(taskHome, 'storage-'));
    const partition = makeSessionPartition({ storageRoot });
    const taskId = 'purge-unconfirmed-boundary';
    const cliPath = path.resolve(__dirname, '../cli/index.js');
    const storeUrl = new URL('../task-lib/store.js', `file://${__filename}`).href;
    const ownershipUrl = new URL('../task-lib/omp-session-ownership.js', `file://${__filename}`)
      .href;
    const env = {
      ...process.env,
      HOME: taskHome,
      USERPROFILE: taskHome,
      ZEROSHOT_HOME: taskHome,
    };
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });

    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            const { addTask } = await import(${JSON.stringify(storeUrl)});
            const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
            addTask({
              id: ${JSON.stringify(taskId)},
              status: 'running',
              provider: 'omp',
              cwd: ${JSON.stringify(storageRoot)},
              pid: ${child.pid},
              processGroupId: ${child.pid},
              terminationStrategy: 'invalid-unconfirmed-strategy',
              ompSessionOwnership: writeProvisionalOwnership({
                partitionId: ${JSON.stringify(partition.partitionId)},
                storageRoot: ${JSON.stringify(storageRoot)},
                canonicalWorkspace: ${JSON.stringify(storageRoot)},
                owner: {
                  kind: 'standalone',
                  clusterId: null,
                  agentId: null,
                  taskId: ${JSON.stringify(taskId)},
                },
              }),
            });
          `,
        ],
        { env }
      );

      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, 'purge', '--yes'], { env }),
        /provider termination is unconfirmed/
      );

      assert.ok(fs.existsSync(partition.partitionPath), 'purge preserves the live partition');
      process.kill(child.pid, 0);
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            const { getTask } = await import(${JSON.stringify(storeUrl)});
            process.stdout.write(JSON.stringify(getTask(${JSON.stringify(taskId)})));
          `,
        ],
        { env }
      );
      const task = JSON.parse(stdout);
      assert.strictEqual(task.status, 'running');
      assert.strictEqual(task.pid, child.pid);
      assert.strictEqual(task.ompSessionOwnership.state, 'provisional');
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The assertion path may already have stopped the fixture.
      }
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

describe('Host follower terminal cleanup recovery', function () {
  this.timeout(10000);

  it('does not resolve terminal status until persisted cleanup succeeds', async function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-host-follower-cleanup-'));
    const taskCliPath = path.join(tempDir, 'zeroshot');
    const logPath = path.join(tempDir, 'task.log');
    const pendingPath = path.join(tempDir, 'cleanup-pending');
    const attemptsPath = path.join(tempDir, 'cleanup-attempts');
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(pendingPath, 'pending');
    fs.writeFileSync(
      taskCliPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const action = process.argv[2];
if (action === 'get-log-path') {
  console.log(${JSON.stringify(logPath)});
} else if (action === 'status') {
  console.log('Status: completed');
  console.log('Cleanup: ' + (fs.existsSync(${JSON.stringify(pendingPath)}) ? 'pending' : 'complete'));
} else if (action === 'kill') {
  const attempts = fs.existsSync(${JSON.stringify(attemptsPath)})
    ? Number(fs.readFileSync(${JSON.stringify(attemptsPath)}, 'utf8')) + 1
    : 1;
  fs.writeFileSync(${JSON.stringify(attemptsPath)}, String(attempts));
  if (attempts === 1) {
    console.error('cleanup temporarily unavailable');
    process.exitCode = 1;
  } else {
    fs.rmSync(${JSON.stringify(pendingPath)}, { force: true });
    console.log('cleanup recovered');
  }
}
`,
      { mode: 0o755 }
    );
    const agent = {
      id: 'host-cleanup-follower',
      config: { cwd: tempDir, outputFormat: 'text' },
      worktree: null,
      isolation: null,
      currentTask: null,
      currentTaskId: 'host-cleanup-task',
      processPid: 123,
      taskCliPath,
      quiet: true,
      messageBus: { publish() {} },
      _resolveProvider: () => 'codex',
      _stopLivenessCheck() {},
      _log() {},
    };
    let settled = false;

    try {
      const execution = followClaudeTaskLogs(agent, agent.currentTaskId).finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(attemptsPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.strictEqual(fs.readFileSync(attemptsPath, 'utf8'), '1');
      assert.strictEqual(settled, false);
      assert.notStrictEqual(agent.currentTask, null);

      const result = await execution;
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(attemptsPath, 'utf8'), '2');
      assert.strictEqual(fs.existsSync(pendingPath), false);
      assert.strictEqual(agent.currentTask, null);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Direct runner terminal cleanup recovery', function () {
  this.timeout(10000);

  it('does not resolve terminal status until persisted cleanup succeeds', async function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-direct-cleanup-'));
    const taskCliPath = path.join(tempDir, 'zeroshot');
    const logPath = path.join(tempDir, 'task.log');
    const pendingPath = path.join(tempDir, 'cleanup-pending');
    const attemptsPath = path.join(tempDir, 'cleanup-attempts');
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(pendingPath, 'pending');
    fs.writeFileSync(
      taskCliPath,
      `#!/usr/bin/env node
      const fs = require('node:fs');
      const action = process.argv[2];
      if (action === 'get-log-path') {
        process.stdout.write(${JSON.stringify(logPath)} + '\\n');
      } else if (action === 'status') {
        const cleanup = fs.existsSync(${JSON.stringify(pendingPath)}) ? 'pending' : 'complete';
        process.stdout.write('Status: completed\\nCleanup: ' + cleanup + '\\n');
      } else if (action === 'kill') {
        const attempts = fs.existsSync(${JSON.stringify(attemptsPath)})
          ? Number(fs.readFileSync(${JSON.stringify(attemptsPath)}, 'utf8'))
          : 0;
        fs.writeFileSync(${JSON.stringify(attemptsPath)}, String(attempts + 1));
        if (attempts === 0) process.exit(1);
        fs.rmSync(${JSON.stringify(pendingPath)}, { force: true });
      }
      `,
      { mode: 0o755 }
    );

    const runner = new ClaudeTaskRunner({ quiet: true, timeout: 8000 });
    let settled = false;
    try {
      const execution = runner._followLogs(taskCliPath, 'direct-cleanup-task', 'direct-agent');
      execution.finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(attemptsPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.strictEqual(fs.readFileSync(attemptsPath, 'utf8'), '1');
      assert.strictEqual(settled, false);
      const result = await execution;
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(attemptsPath, 'utf8'), '2');
      assert.strictEqual(fs.existsSync(pendingPath), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
