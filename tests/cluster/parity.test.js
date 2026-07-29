'use strict';

const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const {
  CLUSTER_METHODS,
  ClusterClient,
  ClusterProtocolError,
  Connection,
  JSON_RPC_ERROR_CODES,
  PROTOCOL_VERSION,
  SUBSCRIPTION_QUEUE_CAPACITY,
} = require('../../lib/cluster/index.cjs');
const { connected, settle } = require('./harness');

const root = resolve(__dirname, '../..');
const protocolRoot = join(root, 'protocol/openengine-cluster/v1');

async function open(client, socket, method, result) {
  const pending =
    method === 'agent/attach' ? client.agentAttach({ execution: 'exec-1' }) : client[method]();
  await settle();
  socket.respond(socket.request(method).id, result);
  return pending;
}

test('generated method and error constants match the authoritative artifacts', () => {
  const openrpc = JSON.parse(readFileSync(join(protocolRoot, 'openrpc.json'), 'utf8'));
  assert.deepEqual(
    [...CLUSTER_METHODS],
    openrpc.methods.map(({ name }) => name)
  );
  assert.equal(CLUSTER_METHODS.length, 12);
  const facadeNames = {
    initialize: 'initialize',
    plan: 'plan',
    apply: 'apply',
    update: 'update',
    stop: 'stop',
    retry: 'retry',
    resubmit: 'resubmit',
    delete: 'delete',
    get: 'get',
    watch: 'watch',
    logs: 'logs',
    'agent/attach': 'agentAttach',
  };
  for (const method of CLUSTER_METHODS)
    assert.equal(typeof ClusterClient.prototype[facadeNames[method]], 'function', method);
  assert.deepEqual(
    Object.values(JSON_RPC_ERROR_CODES),
    [-32700, -32600, -32601, -32602, -32603, -32000]
  );
  const watchRust = readFileSync(
    join(root, 'crates/openengine-cluster-protocol/src/watch.rs'),
    'utf8'
  );
  assert.equal(
    SUBSCRIPTION_QUEUE_CAPACITY,
    Number(
      watchRust
        .match(/DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY: usize = ([0-9_]+)/)[1]
        .replaceAll('_', '')
    )
  );
});

test('every unary facade sends its named OpenRPC method and returns its response', async () => {
  const { socket, connection, client } = connected(Connection, ClusterClient);
  const operational = {
    dispatchState: 'active',
    inFlight: 0,
    labels: {},
    logLevel: 'info',
  };
  const cases = [
    [
      'initialize',
      { protocolVersion: PROTOCOL_VERSION },
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, status: { phase: 'empty' } },
    ],
    ['plan', { graph: {} }, { ok: true, diagnostics: [] }],
    ['apply', { graph: {} }, { phase: 'running', deduped: false }],
    [
      'update',
      { ifGeneration: 1, idempotencyKey: 'update-1', suspended: true },
      {
        atCursor: 'cursor-2',
        deduped: false,
        generation: 2,
        operational,
        phase: 'running',
        runId: 'run-1',
      },
    ],
    [
      'stop',
      { mode: 'drain', ifGeneration: 2, idempotencyKey: 'stop-1' },
      {
        acceptedMode: 'drain',
        atCursor: 'cursor-3',
        deduped: false,
        effectiveMode: 'drain',
        generation: 3,
        operational,
        phase: 'running',
        runId: 'run-1',
      },
    ],
    [
      'retry',
      { ifGeneration: 3, idempotencyKey: 'retry-1' },
      {
        atCursor: 'cursor-4',
        deduped: false,
        generation: 4,
        operational,
        phase: 'running',
        retriedTurnId: 'turn-1',
        retryTurnId: 'turn-2',
        runId: 'run-1',
      },
    ],
    [
      'resubmit',
      { ifGeneration: 4, ifRunId: 'run-1', idempotencyKey: 'resubmit-1' },
      {
        atCursor: 'cursor-5',
        deduped: false,
        generation: 5,
        operational,
        phase: 'running',
        priorRunId: 'run-1',
        runId: 'run-2',
      },
    ],
    [
      'delete',
      { ifGeneration: 5, idempotencyKey: 'delete-1' },
      { deduped: false, deleted: true, phase: 'empty' },
    ],
    ['get', { atCursor: 'cursor-1' }, { status: { phase: 'empty' }, atCursor: 'cursor-1' }],
  ];
  for (const [method, params, result] of cases) {
    const pending = client[method](params);
    await settle();
    const request = socket.request(method);
    assert.deepEqual(request.params, params);
    socket.respond(request.id, result);
    assert.deepEqual(await pending, result);
  }
  await connection.close();
});

test('watch golden and every remaining watch event variant have caller-visible parity', async () => {
  const golden = JSON.parse(readFileSync(join(protocolRoot, 'goldens/watch-session.json'), 'utf8'));
  const fault = JSON.parse(
    readFileSync(join(protocolRoot, 'fixtures/watch/fault-event.json'), 'utf8')
  );
  const extras = [
    { type: 'bookmark' },
    fault,
    { type: 'finished', final_status: { phase: 'finished' } },
  ];
  const { socket, connection, client } = connected(Connection, ClusterClient);
  const { stream } = await open(client, socket, 'watch', {
    subscriptionId: 'sub-1',
    runId: 'run-1',
  });
  for (const params of golden) socket.notify('event', params);
  extras.forEach((event, index) =>
    socket.notify('event', {
      subscriptionId: 'sub-1',
      runId: 'run-1',
      cursor: `extra-${index}`,
      event,
    })
  );
  const visible = [];
  for (let index = 0; index < golden.length + extras.length; index += 1)
    visible.push((await stream.next()).value);
  const publicEvents = visible
    .slice(0, golden.length)
    .map(({ runId, cursor, event }) => ({ runId, cursor, event }));
  const goldenEvents = golden.map(({ runId, cursor, event }) => ({ runId, cursor, event }));
  assert.deepEqual(publicEvents, goldenEvents);
  assert.deepEqual(
    visible.slice(golden.length).map(({ event }) => event),
    extras
  );
  await stream.cancel();
  await connection.close();
});

test('logs and attach goldens replay through the shared subscription machinery', async () => {
  for (const descriptor of [
    {
      method: 'logs',
      file: 'logs-session.json',
      result: { subscriptionId: 'sub-1' },
      field: 'record',
    },
    {
      method: 'agent/attach',
      file: 'agent-attach-session.json',
      result: { subscriptionId: 'sub-1' },
      field: 'event',
    },
  ]) {
    const golden = JSON.parse(readFileSync(join(protocolRoot, 'goldens', descriptor.file), 'utf8'));
    const { socket, connection, client } = connected(Connection, ClusterClient);
    const { stream } = await open(client, socket, descriptor.method, descriptor.result);
    for (const params of golden) socket.notify('event', params);
    const visible = [];
    for (let index = 0; index < golden.length; index += 1)
      visible.push((await stream.next()).value.event);
    assert.deepEqual(
      visible,
      golden.map((entry) => entry[descriptor.field])
    );
    await stream.cancel();
    await connection.close();
  }
});

test('initialize rejects a server protocol-version mismatch', async () => {
  const { socket, connection, client } = connected(Connection, ClusterClient);
  const pending = client.initialize();
  await settle();
  socket.respond(socket.request('initialize').id, {
    protocolVersion: 'future',
    capabilities: {},
    status: { phase: 'empty' },
  });
  await assert.rejects(
    pending,
    (error) =>
      error instanceof ClusterProtocolError && error.code === 'UNSUPPORTED_PROTOCOL_VERSION'
  );
  await connection.close();
});

test('malformed peer frames never escape the pump and leave the connection open', async () => {
  const { socket, connection, client } = connected(Connection, ClusterClient);
  for (const frame of [
    '{',
    'null',
    '[]',
    '{"jsonrpc":"1.0"}',
    '{"jsonrpc":"2.0","method":"event","params":{}}',
  ])
    socket.emit('message', { data: frame });
  assert.equal(connection.state, 'OPEN');
  assert.equal(connection.protocolDiagnostics.length, 5);
  const pending = client.get();
  await settle();
  const request = socket.request('get');
  socket.respond(request.id, { status: { phase: 'empty' } });
  await pending;
  await connection.close();
});

test('protocol constants preserve asymmetric serde close reasons and version', () => {
  assert.equal(PROTOCOL_VERSION, 'openengine.cluster/v1');
  const schema = JSON.parse(readFileSync(join(protocolRoot, 'schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.SubscriptionCloseReason.enum, ['done', 'SLOW_CONSUMER']);
});
