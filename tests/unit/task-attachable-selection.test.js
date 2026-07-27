const { describe, it } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const runnerUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/runner.js')).href;
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const socketDiscoveryPath = path.resolve(__dirname, '../../src/attach/socket-discovery.js');
const socketPaths = require('../../src/attach/socket-paths');

function createFakeCodex(fakeBinDir) {
  const fakeCodex = path.join(fakeBinDir, 'codex');
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('codex exec --json --output-schema --config -m -C --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 1.0.0\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }) + '\\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '{"ok":true}' }
  }) + '\\n');
  process.exit(0);
}, 1000);
`
  );
  fs.chmodSync(fakeCodex, 0o755);
}

function createHarness(shortHome) {
  const harnessPath = path.join(shortHome, 'attach-regression.mjs');
  fs.writeFileSync(
    harnessPath,
    `import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawnTask } = await import(${JSON.stringify(runnerUrl)});
const { getTask } = await import(${JSON.stringify(storeUrl)});
const socketDiscovery = require(${JSON.stringify(socketDiscoveryPath)});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

const task = spawnTask('Return structured output', {
  provider: 'codex',
  model: 'gpt-5.4',
  outputFormat: 'json',
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
});

const attached = await waitFor(() => {
  const current = getTask(task.id);
  return current?.attachable && current.socketPath ? current : null;
});

if (!attached) {
  const current = getTask(task.id);
  const log =
    current?.logFile && fs.existsSync(current.logFile)
      ? fs.readFileSync(current.logFile, 'utf8')
      : '<no log>';
  throw new Error(
    \`watcher never published attach metadata: \${JSON.stringify(current)}\\n\${log}\`
  );
}

if (attached.socketPath !== socketDiscovery.getTaskSocketPath(task.id)) {
  throw new Error(\`unexpected socket path: \${attached.socketPath}\`);
}
if (!(await socketDiscovery.isSocketAlive(attached.socketPath))) {
  throw new Error(\`attach socket is not live: \${attached.socketPath}\`);
}

const completed = await waitFor(() => {
  const current = getTask(task.id);
  return current?.status === 'completed' ? current : null;
});
if (!completed) {
  throw new Error('structured-output task did not complete');
}

const log = fs.readFileSync(completed.logFile, 'utf8');
process.stdout.write(JSON.stringify({ socketPath: attached.socketPath, log }) + '\\n');
`
  );
  return harnessPath;
}

function runHarness(harnessPath, fakeBinDir, testHome, zeroshotHome = testHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        ZEROSHOT_HOME: zeroshotHome,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`attach regression harness timed out\n${stdout}\n${stderr}`));
    }, 12000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`attach regression harness exited ${code}\n${stdout}\n${stderr}`));
        return;
      }
      const output = stdout.trim().split('\n').at(-1);
      resolve(JSON.parse(output));
    });
  });
}

async function runAttachableRegression(options = {}) {
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-fake-codex-'));
  const homeSuffix = options.longHome
    ? `${'deliberately-long-home-segment-'.repeat(5)}${process.pid}-${Date.now()}`
    : `zeroshot-attach-${process.pid}-${Date.now()}`;
  const testHome = path.join('/tmp', homeSuffix);
  const zeroshotHome =
    options.zeroshotHome || path.join('/tmp', `zeroshot-runtime-${process.pid}-${Date.now()}`);
  fs.mkdirSync(testHome, { recursive: true });
  fs.mkdirSync(zeroshotHome, { recursive: true });
  createFakeCodex(fakeBinDir);
  const harnessPath = createHarness(testHome);

  try {
    return await runHarness(harnessPath, fakeBinDir, testHome, zeroshotHome);
  } finally {
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(zeroshotHome, { recursive: true, force: true });
    fs.rmSync(socketPaths.getSocketDir(zeroshotHome), { recursive: true, force: true });
  }
}

describe('task watcher attachment selection', function () {
  async function loadSelector() {
    const runner = await import(runnerUrl);
    expect(runner.shouldUseAttachableWatcher).to.be.a('function');
    return runner.shouldUseAttachableWatcher;
  }

  it('keeps strict structured-output Codex tasks attachable', async function () {
    const shouldUseAttachableWatcher = await loadSelector();

    expect(
      shouldUseAttachableWatcher(
        {
          attachable: true,
          jsonSchema: { type: 'object' },
        },
        'codex'
      )
    ).to.equal(true);
  });

  it('creates a live attach socket for a strict structured-output Codex task', async function () {
    this.timeout(15000);
    const result = await runAttachableRegression();

    expect(result.socketPath).to.match(/\.sock$/);
    expect(result.log).to.include('"type":"thread.started"');
    expect(result.log).to.include('{\\"ok\\":true}');
  });

  it('creates a live attach socket when HOME exceeds the Unix socket path limit', async function () {
    this.timeout(15000);
    const result = await runAttachableRegression({ longHome: true });

    expect(result.socketPath).to.match(/\.sock$/);
    expect(result.socketPath.length).to.be.lessThan(100);
    expect(result.log).to.include('"type":"thread.started"');
    expect(result.log).to.include('{\\"ok\\":true}');
  });

  it('uses ZEROSHOT_HOME consistently for watcher and discovery socket paths', async function () {
    this.timeout(15000);
    const zeroshotHome = path.join('/tmp', `zeroshot-explicit-home-${process.pid}-${Date.now()}`);
    const result = await runAttachableRegression({ longHome: true, zeroshotHome });

    expect(path.dirname(result.socketPath)).to.equal(socketPaths.getSocketDir(zeroshotHome));
    expect(result.log).to.include('{\\"ok\\":true}');
  });

  it('preserves the Claude structured-output PTY safeguard', async function () {
    const shouldUseAttachableWatcher = await loadSelector();

    expect(
      shouldUseAttachableWatcher(
        {
          attachable: true,
          jsonSchema: { type: 'object' },
        },
        'claude'
      )
    ).to.equal(false);
  });

  it('honors an explicit attachment opt-out for every provider', async function () {
    const shouldUseAttachableWatcher = await loadSelector();

    for (const provider of ['codex', 'claude', 'gemini', 'opencode']) {
      expect(
        shouldUseAttachableWatcher(
          {
            attachable: false,
            jsonSchema: { type: 'object' },
          },
          provider
        )
      ).to.equal(false);
    }
  });

  it('keeps non-schema tasks attachable by default', async function () {
    const shouldUseAttachableWatcher = await loadSelector();

    for (const provider of ['codex', 'claude', 'gemini', 'opencode']) {
      expect(shouldUseAttachableWatcher({}, provider)).to.equal(true);
    }
  });
});
