'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { connectClient, nextEvent, smokeGraph } = require('./hosted-oecp-smoke-client');
const { ROOT, capture, inspect, validTag } = require('./hosted-oecp-image-commands');

const SMOKE_FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-smoke-fixture.js');
const CODEX_SMOKE_FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-smoke-codex.mjs');
const CAPABILITY_PATH = '/run/zeroshot-capsule-agent/capability';
const REPOSITORY = 'the-open-engine/zeroshot-smoke';
const BASE_REVISION = 'a'.repeat(40);
const PROMPT_CANARY = 'HOSTED_SMOKE_PROMPT_CANARY';
const GIT_CANARY = 'HOSTED_SMOKE_GIT_TOKEN_CANARY';
const PROVIDER_CANARY = 'HOSTED_SMOKE_PROVIDER_TOKEN_CANARY';

function createCapabilityFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-oecp-smoke-'));
  fs.chmodSync(directory, 0o700);
  const capabilityFile = path.join(directory, 'capability');
  fs.writeFileSync(capabilityFile, crypto.randomBytes(32).toString('hex'), {
    encoding: 'ascii',
    flag: 'wx',
    mode: 0o400,
  });
  return { capabilityFile, directory };
}

function startSmokeContainer(tag, name, capabilityFile) {
  capture('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::8080',
    '--mount',
    `type=bind,src=${SMOKE_FIXTURE},dst=/usr/bin/git,readonly`,
    '--mount',
    `type=bind,src=${SMOKE_FIXTURE},dst=/usr/local/bin/codex,readonly`,
    '--mount',
    `type=bind,src=${CODEX_SMOKE_FIXTURE},dst=/opt/zeroshot/node_modules/@openai/codex/bin/codex.js,readonly`,
    '--mount',
    `type=bind,src=${capabilityFile},dst=/bootstrap-capability,readonly`,
    '--env',
    `ZEROSHOT_OECP_CAPABILITY_FILE=${CAPABILITY_PATH}`,
    '--env',
    `ZEROSHOT_HOSTED_REPOSITORY=${REPOSITORY}`,
    '--env',
    `ZEROSHOT_HOSTED_BASE_REVISION=${BASE_REVISION}`,
    '--env',
    'ZEROSHOT_HOSTED_PROVIDER=codex',
    '--env',
    'ZEROSHOT_HOSTED_MODEL_LEVEL=level1',
    '--env',
    `ZEROSHOT_HOSTED_CREDENTIALS_JSON=${JSON.stringify({ GH_TOKEN: GIT_CANARY, OPENAI_API_KEY: PROVIDER_CANARY })}`,
    '--entrypoint',
    '/bin/sh',
    tag,
    '-c',
    `cp /bootstrap-capability ${CAPABILITY_PATH} && chown 0:0 ${CAPABILITY_PATH} && chmod 0400 ${CAPABILITY_PATH} || exit 1; exec /usr/bin/tini -s -- /usr/local/bin/node /opt/zeroshot/zeroshot-rust/hosted-node/capsule-entrypoint.js`,
  ]);
}

async function waitForServer(name) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = spawnSync(
      'docker',
      ['exec', name, '/usr/local/bin/zeroshot-oecp-server', '--healthcheck'],
      { cwd: ROOT, stdio: 'ignore' }
    );
    if (health.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Hosted image did not become ready: ${capture('docker', ['logs', name])}`);
}

function smokeApplyParams(graph) {
  return {
    graph,
    input: {
      source: 'prompt',
      prompt: PROMPT_CANARY,
      artifacts: [],
      isolationProfile: 'isolation.prepared-worktree@1',
      providerProfile: 'provider.hosted-direct@1',
      repository: REPOSITORY,
      provider: 'codex',
      modelLevel: 'level1',
    },
    dryRun: false,
    idempotencyKey: 'hosted-smoke-apply',
  };
}

async function expectRpcCode(promise, code, successMessage) {
  try {
    await promise;
  } catch (error) {
    if (error.error?.data?.code === code) return;
    throw error;
  }
  throw new Error(successMessage);
}

async function exerciseServer(endpoint, capabilityFile) {
  const client = await connectClient(endpoint, { capabilityFile });
  try {
    const initialized = await client.request(1, 'initialize', {
      protocolVersion: 'openengine.cluster/v1',
    });
    if (
      JSON.stringify(initialized.capabilities.graphProfiles) !==
      '["openengine.graph.single-worker/v1"]'
    ) {
      throw new Error('Hosted initialize advertised an unexpected graph profile');
    }
    const graph = smokeGraph();
    const planned = await client.request(2, 'plan', { graph });
    if (!planned.ok) throw new Error(`Hosted smoke graph was rejected: ${JSON.stringify(planned)}`);
    const applyParams = smokeApplyParams(graph);
    const applied = await client.request(3, 'apply', applyParams);
    if (applied.phase !== 'running' || !applied.runId) {
      throw new Error(`Hosted apply returned an invalid receipt: ${JSON.stringify(applied)}`);
    }
    await client.request(4, 'watch', { runId: applied.runId });
    const events = [];
    try {
      while (events.length < 3) events.push(await nextEvent(client));
    } catch {
      const observed = events.map((record) => record.event?.type ?? 'invalid');
      throw new Error(`Hosted watch stopped after safe event types: ${JSON.stringify(observed)}`);
    }
    const types = events.map((record) => record.event.type);
    if (JSON.stringify(types) !== '["phase","node_begin","node_end"]') {
      throw new Error(`Hosted failure watch order is invalid: ${JSON.stringify(types)}`);
    }
    if (events[2].event.outcome?.status !== 'error') {
      throw new Error(
        `Hosted provider failure was not process-derived: ${JSON.stringify(events[2])}`
      );
    }
    const replay = await client.request(5, 'apply', applyParams);
    if (!replay.deduped || replay.runId !== applied.runId) {
      throw new Error(`Hosted apply replay changed its receipt: ${JSON.stringify(replay)}`);
    }
    await expectRpcCode(
      client.request(6, 'get', {}),
      'FINALIZATION_FAILED',
      'Hosted failed provider run was projected as successful'
    );
    await expectRpcCode(
      client.request(7, 'apply', { ...applyParams, idempotencyKey: 'hosted-smoke-second-apply' }),
      'RUN_CONFLICT',
      'Hosted runtime accepted a distinct second apply'
    );
    const serialized = JSON.stringify(events);
    for (const canary of [PROMPT_CANARY, GIT_CANARY, PROVIDER_CANARY]) {
      if (serialized.includes(canary)) throw new Error('Hosted watch leaked a smoke canary');
    }
  } finally {
    client.socket.destroy();
  }
}

function verifyImageEffects(name) {
  const output = capture('docker', [
    'exec',
    name,
    'node',
    '-e',
    "process.stdout.write(require('fs').readFileSync('/workspace/hosted-smoke-output.txt','utf8'))",
  ]);
  if (output !== 'process-derived hosted smoke output') {
    throw new Error('Hosted provider did not produce the expected workspace effect');
  }
  const logs = capture('docker', ['logs', name]);
  for (const canary of [PROMPT_CANARY, GIT_CANARY, PROVIDER_CANARY]) {
    if (logs.includes(canary)) throw new Error('Hosted image logs leaked a smoke canary');
  }
}

async function smoke(tag) {
  if (!validTag(tag)) throw new Error('Image tag is invalid');
  inspect(tag);
  const capability = createCapabilityFile();
  const name = `zeroshot-oecp-smoke-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  startSmokeContainer(tag, name, capability.capabilityFile);
  try {
    const mapped = capture('docker', ['port', name, '8080/tcp']);
    const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
    await waitForServer(name);
    await exerciseServer({ host: '127.0.0.1', port }, capability.capabilityFile);
    verifyImageEffects(name);
  } finally {
    spawnSync('docker', ['rm', '--force', name], { cwd: ROOT, stdio: 'ignore' });
    fs.rmSync(capability.directory, { force: true, recursive: true });
  }
}

module.exports = { smoke };
