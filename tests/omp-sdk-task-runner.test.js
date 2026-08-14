'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const SPAWN_HELPER = path.join(ROOT, 'tests', 'helpers', 'omp-sdk-task-spawn.js');
const STORE_URL = pathToFileURL(path.join(ROOT, 'task-lib', 'store.js')).href;
const CREDENTIAL = 'OPENAI_API_KEY';
const PROMPT = 'sdk-task-runner-private-prompt-never-log';
const MODEL = 'openai/gpt-5.6-luna';

function sdkSettings() {
  const level = { model: MODEL, reasoningEffort: 'max' };
  return {
    defaultProvider: 'omp',
    providerSettings: {
      omp: {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
        levelOverrides: { level1: level, level2: level, level3: level },
        modelsConfig: { providers: {} },
        auth: {
          mode: 'environment',
          credentials: { openai: { env: CREDENTIAL } },
        },
        tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
        nestedAgents: false,
        mcp: false,
      },
    },
  };
}

function runModule(source, env) {
  return execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: ROOT,
    env,
    maxBuffer: 1024 * 1024,
  });
}

async function storedTask(taskId, env) {
  const script = `
    const { getTask } = await import(${JSON.stringify(STORE_URL)});
    process.stdout.write(JSON.stringify(getTask(${JSON.stringify(taskId)})));
  `;
  const { stdout } = await runModule(script, env);
  return JSON.parse(stdout);
}

async function waitForTerminalTask(taskId, env) {
  const deadline = Date.now() + 10_000;
  let task = null;
  while (Date.now() < deadline) {
    task = await storedTask(taskId, env);
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const log =
    task?.logFile && fs.existsSync(task.logFile) ? fs.readFileSync(task.logFile, 'utf8') : '';
  throw new Error(
    `task ${taskId} did not reach a terminal state: status=${task?.status}, pid=${task?.pid}; log=${log}`
  );
}

describe('OMP SDK detached task runner', function () {
  this.timeout(20_000);

  it('dispatches omitted transport through the SDK watcher and cleans its private request', async function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-sdk-task-home-'));
    const settingsFile = path.join(home, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(sdkSettings()), { mode: 0o600 });
    const env = {
      ...process.env,
      ZEROSHOT_HOME: home,
      ZEROSHOT_SETTINGS_FILE: settingsFile,
      OMP_SDK_TASK_PROMPT: PROMPT,
    };
    delete env[CREDENTIAL];

    try {
      const { stdout } = await execFileAsync(process.execPath, [SPAWN_HELPER], {
        cwd: ROOT,
        env,
        maxBuffer: 1024 * 1024,
      });
      const spawned = JSON.parse(stdout);
      assert.equal(spawned.ompSessionOwnership, null, 'SDK runs must not allocate RPC sessions');
      assert.equal(spawned.commandCleanup.cleanup.length, 1);
      const [privateRoot] = spawned.commandCleanup.cleanup;

      const task = await waitForTerminalTask(spawned.id, env);
      assert.equal(task.status, 'failed');
      assert.equal(task.pid, null);
      assert.equal(task.processGroupId, null);
      assert.equal(task.commandCleanup, null, 'SDK cleanup attestation must clear the receipt');
      assert.match(task.error, /OMP SDK credential OPENAI_API_KEY is missing or invalid/);
      assert.equal(
        fs.existsSync(privateRoot),
        false,
        'the owner-only request root must be removed'
      );

      const log = fs.readFileSync(spawned.logFile, 'utf8');
      assert.match(
        log,
        /^\[\d{13}\]\[ZEROSHOT\]\[LOG_FORMAT\] channel-framed-v2\n/,
        'the SDK watcher must mark even startup-failure logs'
      );
      assert.equal(log.includes(PROMPT), false, 'prompt bytes must not enter watcher diagnostics');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
