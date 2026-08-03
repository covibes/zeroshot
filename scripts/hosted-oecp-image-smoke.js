'use strict';

const crypto = require('crypto');
const { once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { connectClient, nextEvent, smokeGraph } = require('./hosted-oecp-smoke-client');
const { ROOT, capture, inspect, validTag } = require('./hosted-oecp-image-commands');

const SMOKE_FIXTURE = path.join(ROOT, 'scripts', 'hosted-oecp-smoke-fixture.js');

const CAPABILITY_PATH = '/run/zeroshot-capsule-agent/capability';

function createCapabilityFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-oecp-smoke-'));
  fs.chmodSync(directory, 0o700);
  const capabilityFile = path.join(directory, 'capability');
  fs.writeFileSync(capabilityFile, crypto.randomBytes(32).toString('hex'), {
    encoding: 'ascii',
    flag: 'wx',
    mode: 0o400,
  });
  fs.chmodSync(capabilityFile, 0o400);
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
    `type=bind,src=${SMOKE_FIXTURE},dst=/smoke-fixture.js,readonly`,
    '--mount',
    `type=bind,src=${capabilityFile},dst=/bootstrap-capability,readonly`,
    '--env',
    `ZEROSHOT_OECP_CAPABILITY_FILE=${CAPABILITY_PATH}`,
    '--entrypoint',
    '/bin/sh',
    tag,
    '-c',
    `cp /bootstrap-capability ${CAPABILITY_PATH} && chown 0:0 ${CAPABILITY_PATH} && chmod 0400 ${CAPABILITY_PATH} || exit 1; node /smoke-fixture.js >/tmp/smoke-fixture.log 2>&1 & while ! test -S /run/zeroshot-capsule-agent/proxy.sock || ! test -S /run/zeroshot-capsule-agent/delivery.sock || ! grep -q fixture-ready /tmp/smoke-fixture.log; do sleep 0.05; done; exec /usr/bin/tini -s -- /usr/local/bin/zeroshot-oecp-server`,
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
      prompt: 'OPENROUTER_SMOKE_CANARY',
      artifacts: [],
      isolationProfile: 'isolation.prepared-worktree@1',
      providerProfile: 'provider.fixed-proxy@1',
    },
    dryRun: false,
    idempotencyKey: 'hosted-smoke-apply',
  };
}

async function initializeApplyAndWatch(first) {
  const initialized = await first.request(1, 'initialize', {
    protocolVersion: 'openengine.cluster/v1',
  });
  const expectedProfiles = ['openengine.graph.single-worker/v1'];
  if (JSON.stringify(initialized.capabilities.graphProfiles) !== JSON.stringify(expectedProfiles)) {
    throw new Error('Hosted initialize advertised an unexpected graph profile');
  }
  const graph = smokeGraph();
  const planned = await first.request(2, 'plan', { graph });
  if (!planned.ok) throw new Error(`Hosted smoke graph was rejected: ${JSON.stringify(planned)}`);
  const broader = JSON.parse(JSON.stringify(graph));
  broader.profile = 'openengine.graph.full/v1';
  if ((await first.request(3, 'plan', { graph: broader })).ok) {
    throw new Error('Hosted runtime accepted the full graph profile');
  }
  const applyParams = smokeApplyParams(graph);
  const applied = await first.request(4, 'apply', applyParams);
  if (applied.phase !== 'running' || !applied.runId) {
    throw new Error(`Hosted apply returned an invalid receipt: ${JSON.stringify(applied)}`);
  }
  await first.request(5, 'watch', { runId: applied.runId });
  const firstEvents = [await nextEvent(first), await nextEvent(first)];
  if (firstEvents[0].event.type !== 'phase' || firstEvents[1].event.type !== 'node_begin') {
    throw new Error(`Hosted watch prefix is invalid: ${JSON.stringify(firstEvents)}`);
  }
  return { applied, applyParams, firstEvents };
}

async function resumeWatch(endpoint, applied, firstEvents, capabilityFile) {
  const closed = once(firstEvents.client.socket, 'close');
  firstEvents.client.socket.destroy();
  await closed;
  const resumed = await connectClient(endpoint, { capabilityFile });
  await resumed.request(1, 'initialize', { protocolVersion: 'openengine.cluster/v1' });
  await resumed.request(2, 'watch', {
    runId: applied.runId,
    fromCursor: firstEvents.records[1].cursor,
  });
  const suffix = [];
  for (;;) {
    const event = await nextEvent(resumed);
    suffix.push(event);
    if (event.event.type === 'finished') break;
  }
  return { resumed, events: [...firstEvents.records, ...suffix] };
}

function assertWatchEvents(events) {
  const types = events.map((event) => event.event.type);
  const expected = ['phase', 'node_begin', 'node_end', 'finished'];
  if (JSON.stringify(types) !== JSON.stringify(expected)) {
    throw new Error(`Hosted watch order is invalid: ${JSON.stringify(types)}`);
  }
  if (new Set(events.map((event) => event.cursor)).size !== events.length) {
    throw new Error('Hosted watch replay duplicated a cursor');
  }
  const nodeEnd = events[2].event;
  if (
    nodeEnd.outcome.status !== 'verified' ||
    nodeEnd.outcome.output?.summary !== 'Hosted worker completed'
  ) {
    throw new Error(`Hosted worker result was not process-derived: ${JSON.stringify(nodeEnd)}`);
  }
  if (JSON.stringify(events).includes('OPENROUTER_SMOKE_CANARY')) {
    throw new Error('Hosted watch leaked its input canary');
  }
}

async function waitForFinalGet(client, finalCursor) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await client.request(10 + attempt, 'get', {});
    if (current.status.phase !== 'finished') {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (current.atCursor !== finalCursor || current.status.atCursor !== finalCursor) {
      throw new Error(`Hosted final get is incoherent: ${JSON.stringify(current)}`);
    }
    return;
  }
  throw new Error('Hosted final get did not reach Finished');
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

async function verifyFinalContracts(client, applied, applyParams, finalCursor) {
  await waitForFinalGet(client, finalCursor);
  const replay = await client.request(110, 'apply', applyParams);
  if (!replay.deduped || replay.runId !== applied.runId) {
    throw new Error(`Hosted apply replay changed its receipt: ${JSON.stringify(replay)}`);
  }
  await expectRpcCode(
    client.request(111, 'apply', {
      ...applyParams,
      idempotencyKey: 'hosted-smoke-second-apply',
    }),
    'RUN_CONFLICT',
    'Hosted runtime accepted a distinct second apply'
  );
  await expectRpcCode(
    client.request(112, 'watch', { runId: applied.runId }),
    'NOT_FOUND',
    'Hosted runtime accepted a post-task reconnect'
  );
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
    throw new Error('Hosted worker did not produce the expected workspace effect');
  }
  if (capture('docker', ['logs', name]).includes('OPENROUTER_SMOKE_CANARY')) {
    throw new Error('Hosted image logs leaked the input canary');
  }
}

async function exerciseServer(name, endpoint, capabilityFile) {
  const first = await connectClient(endpoint, { capabilityFile });
  let resumed;
  try {
    const task = await initializeApplyAndWatch(first);
    const reconnect = await resumeWatch(
      endpoint,
      task.applied,
      {
        client: first,
        records: task.firstEvents,
      },
      capabilityFile
    );
    resumed = reconnect.resumed;
    assertWatchEvents(reconnect.events);
    await verifyFinalContracts(resumed, task.applied, task.applyParams, reconnect.events[3].cursor);
    verifyImageEffects(name);
  } finally {
    first.socket.destroy();
    resumed?.socket.destroy();
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
    await exerciseServer(name, { host: '127.0.0.1', port }, capability.capabilityFile);
  } finally {
    spawnSync('docker', ['rm', '--force', name], { cwd: ROOT, stdio: 'ignore' });
    fs.rmSync(capability.directory, { force: true, recursive: true });
  }
}

module.exports = { smoke };
