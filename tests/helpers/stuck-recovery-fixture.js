const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ledger = require('../../src/ledger');

const REPO_ROOT = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function workerConfig(maxRetries, timeout, staleDuration = 1500, role = 'implementation') {
  return {
    defaultProvider: 'codex',
    agents: [
      {
        id: 'worker',
        role,
        provider: 'codex',
        modelLevel: 'level2',
        outputFormat: 'json',
        jsonSchema: {
          type: 'object',
          properties: { done: { type: 'boolean' } },
          required: ['done'],
        },
        staleDuration,
        timeout,
        maxRetries,
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: {
              topic: 'CLUSTER_COMPLETE',
              content: { data: { repaired: '{{result.done}}' } },
            },
          },
        },
      },
    ],
  };
}

function setupFixture({ actions, maxRetries, timeout, staleDuration, prefix, role }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, '.zeroshot');
  const bin = path.join(root, 'bin');
  const storage = path.join(root, 'clusters');
  const stateFile = path.join(root, 'codex-count');
  const settingsFile = path.join(root, 'settings.json');
  const configFile = path.join(root, 'cluster.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'cli/index.js'), path.join(bin, 'zeroshot'));
  fs.symlinkSync(
    path.join(REPO_ROOT, 'tests/fixtures/fake-codex-recovery.js'),
    path.join(bin, 'codex')
  );
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      defaultProvider: 'codex',
      maxRestartAttempts: 1,
      maxTotalRestarts: 2,
      staleWarningsBeforeKill: 2,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      jitterFactor: 0,
    })
  );
  fs.writeFileSync(
    configFile,
    JSON.stringify(workerConfig(maxRetries, timeout, staleDuration, role))
  );
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    ZEROSHOT_HOME: root,
    ZEROSHOT_SETTINGS_FILE: settingsFile,
    FAKE_CODEX_COUNT: stateFile,
    FAKE_CODEX_ACTIONS: JSON.stringify(actions),
    NODE_ENV: 'test',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  return { root, home, storage, stateFile, configFile, env };
}

function runProcess(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`fixture failed (${code}): ${stderr}\n${stdout}`));
      }
    });
  });
}

async function runInProcessRecovery() {
  const fixture = setupFixture({
    actions: ['hang', 'success'],
    maxRetries: 1,
    timeout: 5000,
    prefix: 'zeroshot-fake-hang-',
  });
  try {
    const stdout = await runProcess(
      [path.join(REPO_ROOT, 'tests/fixtures/run-stuck-recovery.js')],
      {
        env: {
          ...fixture.env,
          RECOVERY_CONFIG: fixture.configFile,
          RECOVERY_STORAGE_DIR: fixture.storage,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
    if (!line) throw new Error(`missing fixture result in:\n${stdout}`);
    return JSON.parse(line.slice('RESULT:'.length));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function runStructuredOutputRecovery({
  initialAction = 'malformed',
  recoveryAction = 'success',
} = {}) {
  const fixture = setupFixture({
    actions: [initialAction],
    maxRetries: 1,
    timeout: 20000,
    staleDuration: 15000,
    prefix: 'zeroshot-structured-recovery-',
    role: 'planner',
  });
  try {
    const stdout = await runProcess(
      [path.join(REPO_ROOT, 'tests/fixtures/run-stuck-recovery.js')],
      {
        env: {
          ...fixture.env,
          RECOVERY_CONFIG: fixture.configFile,
          RECOVERY_STORAGE_DIR: fixture.storage,
          FAKE_CODEX_RECOVERY_ACTION: recoveryAction,
          FAKE_CODEX_EMIT_SESSION: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT:'));
    if (!line) throw new Error(`missing fixture result in:\n${stdout}`);
    return JSON.parse(line.slice('RESULT:'.length));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function readSavedCluster(fixture, clusterId) {
  const registryPath = path.join(fixture.home, 'clusters.json');
  if (!fs.existsSync(registryPath)) return null;
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'))[clusterId] || null;
}

async function waitForDetachedStop(fixture, clusterId) {
  const deadline = Date.now() + 25000;
  let saved = null;
  let daemonPid = null;
  while (Date.now() < deadline) {
    saved = readSavedCluster(fixture, clusterId);
    daemonPid = saved?.pid || daemonPid;
    const agent = saved?.agentStates?.[0];
    if (
      saved?.state === 'stopped' &&
      agent?.currentTask === false &&
      agent?.currentTaskId === null &&
      agent?.processPid === null
    ) {
      return { saved, daemonPid };
    }
    await sleep(50);
  }
  return { saved, daemonPid };
}

function readLifecycle(home, clusterId) {
  const ledger = new Ledger(path.join(home, `${clusterId}.db`), { readonly: true });
  try {
    return ledger
      .query({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: 'worker',
      })
      .map((message) => message.content.data.event);
  } finally {
    ledger.close();
  }
}

async function terminateDaemon(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(25);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process exited during the bounded graceful wait.
  }
}

async function runDetachedRecovery() {
  const fixture = setupFixture({
    actions: ['hang', 'exit', 'success'],
    maxRetries: 3,
    timeout: 10000,
    prefix: 'zeroshot-detached-hang-',
  });
  let daemonPid = null;
  try {
    const stdout = await runProcess(
      [
        path.join(REPO_ROOT, 'cli/index.js'),
        'run',
        'detached fake provider recovery',
        '--config',
        fixture.configFile,
        '--provider',
        'codex',
        '--sim',
        'off',
        '--detach',
      ],
      {
        cwd: REPO_ROOT,
        env: fixture.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const clusterId = stdout.match(/Started ([a-z]+-[a-z]+-\d+)/)?.[1];
    if (!clusterId) throw new Error(`missing detached cluster id in:\n${stdout}`);
    const stopped = await waitForDetachedStop(fixture, clusterId);
    daemonPid = stopped.daemonPid;
    return {
      state: stopped.saved?.state,
      pid: stopped.saved?.pid,
      fakeCount: fs.readFileSync(fixture.stateFile, 'utf8'),
      lifecycle: readLifecycle(fixture.home, clusterId),
    };
  } finally {
    await terminateDaemon(daemonPid);
    fs.rmSync(fixture.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

module.exports = { runDetachedRecovery, runInProcessRecovery, runStructuredOutputRecovery };
