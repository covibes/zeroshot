'use strict';

const { ok: invariant } = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { connectWebSocketClient, nextEvent, smokeGraph } = require('./hosted-oecp-smoke-client');

const REPOSITORY = 'the-open-engine/zeroshot-smoke';
const GIT_CANARY = 'HOSTED_CERTIFICATION_GIT_TOKEN';
const PROVIDER_CANARY = 'HOSTED_CERTIFICATION_PROVIDER_TOKEN';
const AUTHORITY_CANARIES = Object.freeze([
  GIT_CANARY,
  PROVIDER_CANARY,
  REPOSITORY,
  'openrouter.ai',
  'level2',
]);
const INTENT_ID = '019f7437-8701-71e3-a056-2ba05c37609c';
const OTHER_INTENT_ID = '019f7437-8701-71e3-a056-2ba05c37609d';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function queueEnvelope(prompt) {
  const input = { source: 'prompt', prompt, artifacts: [] };
  invariant(
    JSON.stringify(Object.keys(input).sort()) === JSON.stringify(['artifacts', 'prompt', 'source']),
    'Queued input contains runtime authority'
  );
  return Buffer.from(
    JSON.stringify({
      version: 'zeroshot.run-intent/v2',
      graph: smokeGraph(),
      input,
    })
  );
}

function runIntentRequest(capability, options) {
  const { method, intentId = INTENT_ID, digest, body } = options;
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: 8084,
        method,
        path: `/internal/run-intents/${intentId}`,
        headers: {
          'x-zero-runtime-capability': capability,
          'x-zero-run-intent-digest': digest,
          ...(body
            ? {
                'content-length': body.length,
                'content-type': 'application/json',
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 11 * 1024 * 1024) {
            request.destroy(new Error('RunIntent certification response exceeded its bound'));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(10_000, () => request.destroy(new Error('RunIntent request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function assertNoCanaries(value, label, canaries) {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    invariant(!serialized.includes(canary), `${label} leaked runtime authority`);
  }
}

function assertNoAuthority(value, label) {
  assertNoCanaries(value, label, AUTHORITY_CANARIES);
}

async function pollRunIntent(capability, digest) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await runIntentRequest(capability, { method: 'GET', digest });
    if (response.body.state !== 'running') return response;
    invariant(Date.now() < deadline, 'RunIntent did not become terminal');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exerciseRunIntent(capability, expectedState) {
  const body = queueEnvelope(`certification-${expectedState}`);
  const digest = sha256(body);
  const mismatch = await runIntentRequest(capability, {
    method: 'PUT',
    digest: `sha256:${'0'.repeat(64)}`,
    body,
  });
  invariant(
    mismatch.status === 409 && mismatch.body.error_code === 'digest_mismatch',
    'RunIntent accepted a digest mismatch'
  );

  const accepted = await runIntentRequest(capability, { method: 'PUT', digest, body });
  invariant(
    accepted.status === 202 && accepted.body.state === 'running',
    'RunIntent was not accepted'
  );

  const terminal = await pollRunIntent(capability, digest);
  invariant(
    terminal.body.state === expectedState,
    `RunIntent ended in ${terminal.body.state} (${terminal.body.error_code || 'no error code'})`
  );
  if (expectedState === 'succeeded') {
    invariant(terminal.status === 200, 'Successful RunIntent returned the wrong status');
    invariant(
      JSON.stringify(Object.keys(terminal.body.result).sort()) ===
        JSON.stringify(['artifacts', 'status', 'summary']),
      'Successful RunIntent returned private result fields'
    );
  } else {
    invariant(
      terminal.status === 422 && /^[a-z][a-z0-9_]{0,63}$/.test(terminal.body.error_code),
      'Failed RunIntent returned an invalid terminal error'
    );
  }
  assertNoAuthority(terminal.body, 'RunIntent terminal result');

  const terminalReplay = await runIntentRequest(capability, { method: 'PUT', digest, body });
  invariant(
    terminalReplay.status === terminal.status &&
      JSON.stringify(terminalReplay.body) === JSON.stringify(terminal.body),
    'Terminal RunIntent replay changed its result'
  );

  const conflictingBody = queueEnvelope('certification-conflict');
  const conflict = await runIntentRequest(capability, {
    method: 'PUT',
    intentId: OTHER_INTENT_ID,
    digest: sha256(conflictingBody),
    body: conflictingBody,
  });
  invariant(
    conflict.status === 409 && conflict.body.error_code === 'intent_conflict',
    'RunIntent accepted a conflicting owner'
  );
  const digestConflict = await runIntentRequest(capability, {
    method: 'GET',
    digest: sha256(conflictingBody),
  });
  invariant(digestConflict.status === 409, 'RunIntent GET accepted a conflicting digest');
}

async function expectRpcCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error.error?.data?.code === code) return;
    throw error;
  }
  throw new Error(`WebSocket request unexpectedly succeeded instead of returning ${code}`);
}

async function exerciseWebSocket(capability) {
  const client = await connectWebSocketClient(
    { host: '127.0.0.1', port: 8083 },
    { capability, requestTimeoutMs: 10_000 }
  );
  try {
    const initialized = await client.request(1, 'initialize', {
      protocolVersion: 'openengine.cluster/v1',
    });
    invariant(
      initialized.capabilities.graphProfiles.includes('openengine.graph.single-worker/v1'),
      'WebSocket initialize omitted the hosted graph profile'
    );
    const graph = smokeGraph();
    const planned = await client.request(2, 'plan', { graph });
    invariant(planned.ok === true, 'WebSocket plan rejected the certification graph');
    const applied = await client.request(3, 'apply', {
      graph,
      input: {
        source: 'prompt',
        prompt: 'authenticated WebSocket certification',
        artifacts: [],
        isolationProfile: 'isolation.prepared-worktree@1',
        providerProfile: 'provider.hosted-direct@1',
        repository: REPOSITORY,
        provider: 'codex',
        modelLevel: 'level2',
      },
      dryRun: false,
      idempotencyKey: 'hosted-certification-websocket',
    });
    invariant(applied.phase === 'running' && applied.runId, 'WebSocket apply was not admitted');
    await client.request(4, 'watch', { runId: applied.runId });
    const events = [];
    while (!events.some((record) => record.event?.type === 'node_end')) {
      invariant(events.length < 10, 'WebSocket watch did not finish within its event bound');
      events.push(await nextEvent(client));
    }
    invariant(
      events.some(
        (record) => record.event?.type === 'node_end' && record.event.outcome?.status === 'error'
      ),
      'WebSocket worker failure did not reach the real hosted runtime'
    );
    assertNoCanaries(events, 'WebSocket events', [GIT_CANARY, PROVIDER_CANARY]);
    await expectRpcCode(client.request(5, 'get', {}), 'FINALIZATION_FAILED');
  } finally {
    client.socket.destroy();
  }
}

module.exports = {
  GIT_CANARY,
  INTENT_ID,
  PROVIDER_CANARY,
  REPOSITORY,
  exerciseRunIntent,
  exerciseWebSocket,
  queueEnvelope,
  runIntentRequest,
  sha256,
};
