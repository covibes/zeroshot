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
});
