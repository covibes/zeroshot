'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const {
  ClusterClient,
  ClusterRpcError,
  Connection,
  connect,
  connectInitialized,
} = require('../../lib/cluster/index.cjs');
const { FakeWebSocket, assertClean, deferred, establish, settle } = require('./harness');

test('watch reconnect consumes once, uses only the fresh connection, and preserves pair dedup', async () => {
  const oldSocket = new FakeWebSocket();
  const oldConnection = new Connection(oldSocket);
  const { stream } = await establish(new ClusterClient(oldConnection), oldSocket, 'watch', {
    subscriptionId: 'old-watch',
    runId: 'run-1',
  });
  const first = stream.next();
  oldSocket.notify('event', {
    subscriptionId: 'old-watch',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  await first;
  await oldConnection.close();
  const freshSocket = new FakeWebSocket();
  const freshConnection = new Connection(freshSocket);
  const reconnected = stream.reconnect(freshConnection);
  const rejectedFresh = new Connection(new FakeWebSocket());
  assert.throws(() => stream.reconnect(rejectedFresh), { code: 'RECONNECT_CONSUMED' });
  await rejectedFresh.close();
  await settle();
  const request = freshSocket.request('watch');
  assert.deepEqual(request.params, { runId: 'run-1', fromCursor: 'cursor-1' });
  assert.equal(oldSocket.sent.filter((frame) => frame.method === 'watch').length, 1);
  freshSocket.respond(request.id, { subscriptionId: 'fresh-watch', runId: 'run-1' });
  const replacement = await reconnected;
  const next = replacement.stream.next();
  freshSocket.notify('event', {
    subscriptionId: 'fresh-watch',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  freshSocket.notify('event', {
    subscriptionId: 'fresh-watch',
    runId: 'run-2',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  assert.deepEqual((await next).value, {
    type: 'event',
    runId: 'run-2',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  await replacement.stream.cancel();
  await oldConnection.close();
  await freshConnection.close();
});
test('a failed reconnect closes the supplied fresh connection', async () => {
  const oldSocket = new FakeWebSocket();
  const oldConnection = new Connection(oldSocket);
  const { stream } = await establish(new ClusterClient(oldConnection), oldSocket, 'watch', {
    subscriptionId: 'old-watch',
    runId: 'run-1',
  });
  const freshSocket = new FakeWebSocket();
  const freshConnection = new Connection(freshSocket);
  const reconnect = stream.reconnect(freshConnection);
  await settle();
  const request = freshSocket.request('watch');
  freshSocket.error(request.id, -32000, 'unavailable', 'GONE');
  await assert.rejects(reconnect, { code: 'GONE' });
  assert.equal(freshConnection.state, 'CLOSED');
  assert.equal(freshSocket.closeCalls, 1);
  await oldConnection.close();
});

test('cold start performs coherent get then watch on one connection', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const pending = new ClusterClient(connection).watchColdStart({ runId: 'run-1' });
  await settle();
  const get = socket.request('get');
  socket.respond(get.id, { status: { phase: 'running' }, atCursor: 'snapshot-3' });
  await settle();
  const watch = socket.request('watch');
  assert.deepEqual(
    socket.sent.filter((frame) => 'id' in frame).map(({ method }) => method),
    ['get', 'watch']
  );
  assert.deepEqual(watch.params, { runId: 'run-1', fromCursor: 'snapshot-3' });
  socket.respond(watch.id, { subscriptionId: 'watch-1', runId: 'run-1' });
  const result = await pending;
  await result.stream.cancel();
  await connection.close();
});

test('close never rejects and mandatory teardown wins cancellation failures', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const client = new ClusterClient(connection);
  const logs = await establish(client, socket, 'logs', { subscriptionId: 'logs-1' });
  const pending = client.get();
  await settle();
  socket.sendFailure = new Error('dead socket');
  socket.closeFailure = new Error('close failed');
  await Promise.all([connection.close(), connection.close(), connection.close()]);
  await assert.rejects(pending, { code: 'CONNECTION_CLOSED' });
  assertClean(connection);
  assert.equal(connection.state, 'CLOSED');
  assert.equal(connection.closeDiagnostics.length, 2);
  assert.deepEqual(await logs.stream.next(), { done: true, value: undefined });
});

test('close at a gated send boundary drains the request and closes once', async () => {
  const socket = new FakeWebSocket();
  socket.sendGate = deferred();
  const connection = new Connection(socket);
  const pending = new ClusterClient(connection).get();
  await settle();
  const closes = [connection.close(), connection.close(), connection.close()];
  socket.sendGate.resolve();
  await assert.rejects(pending, { code: 'CONNECTION_CLOSED' });
  await Promise.all(closes);
  assert.equal(socket.closeCalls, 1);
  assertClean(connection);
});

test('all JSON-RPC and domain errors map to typed errors', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const client = new ClusterClient(connection);
  for (const [index, code] of [-32700, -32600, -32601, -32602, -32603, -32000].entries()) {
    const pending = client.get();
    await settle();
    const request = socket.request('get', index);
    socket.error(request.id, code, 'failure', index === 5 ? 'NOT_FOUND' : undefined);
    await assert.rejects(
      pending,
      (error) =>
        error instanceof ClusterRpcError &&
        error.rpcCode === code &&
        (index !== 5 || error.code === 'NOT_FOUND')
    );
  }
  await connection.close();
});

test('connect destroys a socket when initialization fails', async () => {
  const socket = new FakeWebSocket();
  const pending = connect('ws://cluster', { webSocketFactory: () => socket });
  await settle();
  const request = socket.request('initialize');
  socket.respond(request.id, {
    protocolVersion: 'future',
    capabilities: {},
    status: { phase: 'empty' },
  });
  await assert.rejects(pending, { code: 'UNSUPPORTED_PROTOCOL_VERSION' });
  assert.equal(socket.readyState, 3);
  assert.ok(socket.closeCalls >= 1);
});

test('connectInitialized returns connection, client, and initializeResult', async () => {
  const socket = new FakeWebSocket();
  const pending = connectInitialized('ws://test', { webSocketFactory: () => socket });
  await settle();
  const request = socket.request('initialize');
  const initResult = {
    protocolVersion: 'openengine.cluster/v1',
    capabilities: { logs: true, agentAttach: true, graphProfiles: ['openengine.graph.full/v1'] },
    status: { phase: 'running' },
  };
  socket.respond(request.id, initResult);
  const result = await pending;
  assert.ok(result.connection instanceof Connection);
  assert.ok(result.client instanceof ClusterClient);
  assert.equal(result.initializeResult.protocolVersion, 'openengine.cluster/v1');
  assert.equal(result.initializeResult.capabilities.logs, true);
  assert.equal(result.initializeResult.status.phase, 'running');
  await result.connection.close();
});

test('connect options forward headers to factory', async () => {
  const socket = new FakeWebSocket();
  let capturedOptions;
  const factory = (_url, _protocols, options) => {
    capturedOptions = options;
    return socket;
  };
  const pending = connect('ws://test', {
    webSocketFactory: factory,
    headers: { Authorization: 'Bearer secret' },
  });
  await settle();
  assert.deepEqual(capturedOptions, { headers: { Authorization: 'Bearer secret' } });
  const request = socket.request('initialize');
  socket.respond(request.id, {
    protocolVersion: 'openengine.cluster/v1',
    capabilities: {},
    status: { phase: 'empty' },
  });
  const connection = await pending;
  await connection.close();
});

test('default factory bypasses browser WebSocket for authenticated ws upgrades', async () => {
  let authorization;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(401);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class FakeBrowserWS {
    constructor() {
      throw new Error('browser WebSocket must not receive authenticated upgrades');
    }
  };
  try {
    await assert.rejects(
      connect(`ws://127.0.0.1:${address.port}`, {
        headers: { Authorization: 'Bearer upgrade-canary' },
      }),
      (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.message.includes('upgrade-canary'), false);
        return true;
      }
    );
    assert.equal(authorization, 'Bearer upgrade-canary');
  } finally {
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('close snapshots retain only numeric peer state and redact raw reasons', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  assert.equal(connection.closeCode, undefined);
  assert.equal(connection.closeReason, undefined);
  socket.emit('close', { code: 4401, reason: 'CANARY_REFRESH_920' });
  const closed = await connection.closed;
  assert.equal(connection.closeCode, 4401);
  assert.equal(connection.closeReason, undefined);
  assert.deepEqual(closed, { code: 4401, reason: null });
  assert.deepEqual(connection.closeSnapshot, { code: 4401, reason: null });
  assert.equal(JSON.stringify(closed).includes('CANARY_REFRESH_920'), false);
});
