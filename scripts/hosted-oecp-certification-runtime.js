'use strict';

const { ok: invariant } = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capture } = require('./hosted-oecp-image-commands');
const {
  GIT_CANARY,
  INTENT_ID,
  PROVIDER_CANARY,
  REPOSITORY,
  exerciseRunIntent,
  exerciseWebSocket,
  queueEnvelope,
  runIntentRequest,
  sha256,
} = require('./hosted-oecp-certification-scenarios');

const ROOT = path.resolve(__dirname, '..');
const BASE_REVISION = 'a'.repeat(40);
const FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-smoke-fixture.js');
const CODEX_FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-smoke-codex.mjs');
const SHIP_FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-certification-workspace-ship.js');
const PRODUCTION_SHIP = path.join(ROOT, 'zeroshot-rust', 'hosted-node', 'workspace-ship.js');
const CONTAINER_SHIP_ROOT = '/opt/zeroshot/zeroshot-rust/hosted-node';
const PORTS = Object.freeze([8083, 8084, 8085]);

function containerLogs(name) {
  const result = spawnSync('docker', ['logs', name], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker logs ${name} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function assertPortsAvailable() {
  return Promise.all(
    PORTS.map(
      (port) =>
        new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', () =>
            reject(new Error(`Hosted certification requires unused local port ${port}`))
          );
          server.listen(port, '0.0.0.0', () => server.close(resolve));
        })
    )
  );
}

function prepareMounts(directory, mode) {
  const files = [
    [FIXTURE, 'git', 0o755],
    [CODEX_FIXTURE, 'codex.mjs', 0o755],
    [PRODUCTION_SHIP, 'workspace-ship-production.js', 0o644],
    [SHIP_FIXTURE, 'workspace-ship.js', 0o644],
  ];
  const mounts = {};
  for (const [source, name, fileMode] of files) {
    const destination = path.join(directory, name);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fileMode);
    mounts[name] = destination;
  }
  mounts.mode = path.join(directory, 'mode');
  fs.writeFileSync(mounts.mode, `${mode}\n`, { mode: 0o644 });
  fs.chmodSync(mounts.mode, 0o644);
  return mounts;
}

function containerArguments(tag, name, capability, mounts) {
  const mount = (source, target) => `type=bind,src=${source},dst=${target},readonly`;
  return [
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'host',
    '--mount',
    mount(mounts.git, '/usr/bin/git'),
    '--mount',
    mount(mounts.git, '/usr/local/bin/codex'),
    '--mount',
    mount(mounts['codex.mjs'], '/opt/zeroshot/node_modules/@openai/codex/bin/codex.js'),
    '--mount',
    mount(mounts.mode, '/tmp/zeroshot-oecp-certification-mode'),
    '--mount',
    mount(
      mounts['workspace-ship-production.js'],
      `${CONTAINER_SHIP_ROOT}/workspace-ship-production.js`
    ),
    '--mount',
    mount(mounts['workspace-ship.js'], `${CONTAINER_SHIP_ROOT}/workspace-ship.js`),
    '--env',
    `ZEROSHOT_OECP_RUNTIME_CAPABILITY=${capability}`,
    '--env',
    'ZEROSHOT_OECP_CAPABILITY_FILE=/run/zeroshot-capsule-agent/capability',
    '--env',
    `ZEROSHOT_HOSTED_REPOSITORY=${REPOSITORY}`,
    '--env',
    `ZEROSHOT_HOSTED_BASE_REVISION=${BASE_REVISION}`,
    '--env',
    'ZEROSHOT_HOSTED_PROVIDER=codex',
    '--env',
    'ZEROSHOT_HOSTED_MODEL_LEVEL=level2',
    '--env',
    'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
    '--env',
    `ZEROSHOT_HOSTED_CREDENTIALS_JSON=${JSON.stringify({
      GH_TOKEN: GIT_CANARY,
      OPENAI_API_KEY: PROVIDER_CANARY,
    })}`,
    tag,
  ];
}

async function waitForServer(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const health = spawnSync(
      'docker',
      ['exec', name, '/usr/local/bin/zeroshot-oecp-server', '--healthcheck'],
      { cwd: ROOT, stdio: 'ignore' }
    );
    if (health.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Hosted image did not become ready: ${containerLogs(name)}`);
}

function assertContainerLogs(name) {
  const logs = containerLogs(name);
  for (const canary of [GIT_CANARY, PROVIDER_CANARY]) {
    invariant(!logs.includes(canary), 'Hosted image logs leaked a credential canary');
  }
}

function removeContainer(name) {
  spawnSync('docker', ['rm', '--force', name], { cwd: ROOT, stdio: 'ignore' });
}

async function withContainer(tag, mode, exercise) {
  await assertPortsAvailable();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-oecp-certification-mode-'));
  const mounts = prepareMounts(directory, mode);
  const name = `zeroshot-oecp-certification-${mode}-${process.pid}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const capability = crypto.randomBytes(32).toString('hex');
  capture('docker', containerArguments(tag, name, capability, mounts));
  try {
    await waitForServer(name);
    await exercise({ capability, name });
    assertContainerLogs(name);
  } finally {
    removeContainer(name);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function exerciseShutdown(tag) {
  await assertPortsAvailable();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-oecp-certification-mode-'));
  const mounts = prepareMounts(directory, 'slow');
  const name = `zeroshot-oecp-certification-shutdown-${process.pid}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
  const capability = crypto.randomBytes(32).toString('hex');
  capture('docker', containerArguments(tag, name, capability, mounts));
  try {
    await waitForServer(name);
    const body = queueEnvelope('certification-shutdown');
    const accepted = await runIntentRequest(capability, {
      method: 'PUT',
      intentId: INTENT_ID,
      digest: sha256(body),
      body,
    });
    invariant(accepted.status === 202, 'Slow RunIntent was not admitted before shutdown');
    assertContainerLogs(name);
    const started = Date.now();
    capture('docker', ['kill', '--signal', 'TERM', name]);
    const deadline = started + 20_000;
    for (;;) {
      const state = spawnSync(
        'docker',
        [
          'inspect',
          '--format',
          '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}',
          name,
        ],
        { cwd: ROOT, encoding: 'utf8' }
      );
      invariant(state.status === 0, 'Shutdown container disappeared before its exit was inspected');
      const [running, oomKilled, exitCode] = state.stdout.trim().split(' ');
      if (running === 'false') {
        invariant(oomKilled === 'false', 'Hosted shutdown was OOM-killed');
        invariant(['0', '143'].includes(exitCode), `Hosted shutdown exited with ${exitCode}`);
        break;
      }
      invariant(
        Date.now() < deadline,
        'Hosted shutdown exceeded its 20 second certification bound'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    removeContainer(name);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function exerciseImage(tag) {
  await withContainer(tag, 'failure', async ({ capability }) => {
    await exerciseWebSocket(capability);
  });
  await withContainer(tag, 'success', async ({ capability, name }) => {
    await exerciseRunIntent(capability, 'succeeded');
    const effect = capture('docker', [
      'exec',
      name,
      'node',
      '-e',
      "process.stdout.write(require('fs').readFileSync('/workspace/hosted-smoke-output.txt','utf8'))",
    ]);
    invariant(
      effect === 'process-derived hosted smoke output',
      'Queued success had no workspace effect'
    );
  });
  await withContainer(tag, 'failure', async ({ capability }) => {
    await exerciseRunIntent(capability, 'failed');
  });
  await exerciseShutdown(tag);
}

module.exports = { exerciseImage, REPOSITORY };
