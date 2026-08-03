'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AgentAttachSubscriptionStream,
  CLOSE_REASON_MAX_BYTES,
  ClusterClient,
  ClusterRpcError,
  Connection,
  connect,
  connectInitialized,
  LogsSubscriptionStream,
  MAX_FRAME_BYTES,
  SUBSCRIPTION_QUEUE_CAPACITY,
} = require('../../lib/cluster/index.cjs');
const { FakeWebSocket, assertClean, deferred, settle } = require('./harness');

async function establish(client, socket, method, result) {
  const pending =
    method === 'agent/attach' ? client.agentAttach({ execution: 'exec-1' }) : client[method]();
  await settle();
  const request = socket.request(method);
  socket.respond(request.id, result);
  return pending;
}

test('one connection owns collision-free ids across clients and subscriptions', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const first = new ClusterClient(connection);
  const second = new ClusterClient(connection);
  const calls = [first.get(), second.get(), first.get(), second.logs()];
  await settle();
  const requests = socket.sent.filter((frame) => 'id' in frame);
  assert.equal(new Set(requests.map(({ id }) => id)).size, 4);
  for (const request of requests)
    socket.respond(
      request.id,
      request.method === 'logs' ? { subscriptionId: 'logs-1' } : { status: { phase: 'empty' } }
    );
  const [, , , logs] = await Promise.all(calls);
  await logs.stream.cancel();
  await connection.close();
  assertClean(connection);
});

test('failed sends remove only their exact pending entry', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const client = new ClusterClient(connection);
  const first = client.get();
  await settle();
  const firstRequest = socket.request('get');
  socket.sendFailure = new Error('closed');
  await assert.rejects(client.get(), { code: 'SEND_FAILED' });
  assert.equal(connection.pendingSize, 1);
  socket.sendFailure = undefined;
  socket.respond(firstRequest.id, { status: { phase: 'empty' } });
  await first;
  for (let index = 0; index < 100; index += 1) {
    socket.sendFailure =
      index % 2 === 0 ? new Error('closed') : Promise.reject(new Error('closed'));
    await assert.rejects(client.get(), { code: 'SEND_FAILED' });
    assert.equal(connection.pendingSize, 0);
  }
  socket.sendFailure = undefined;
  await connection.close();
});

test('bounded queue retains the pre-overflow FIFO then closes once', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const { stream } = await establish(new ClusterClient(connection), socket, 'logs', {
    subscriptionId: 'logs-1',
  });
  assert.ok(stream instanceof LogsSubscriptionStream);
  for (let index = 0; index < SUBSCRIPTION_QUEUE_CAPACITY + 1; index += 1)
    socket.notify('event', {
      subscriptionId: 'logs-1',
      record: { level: 'info', target: 'test', message: String(index) },
    });
  await settle();
  assert.equal(connection.subscriptionCount, 0);
  assert.equal(stream.retainedCount, SUBSCRIPTION_QUEUE_CAPACITY);
  assert.deepEqual(socket.notifications('subscription/cancel').at(-1).params, {
    subscriptionId: 'logs-1',
  });
  for (let index = 0; index < SUBSCRIPTION_QUEUE_CAPACITY; index += 1)
    assert.equal((await stream.next()).value.event.message, String(index));
  assert.deepEqual(await stream.next(), {
    done: false,
    value: { type: 'closed', reason: 'SLOW_CONSUMER' },
  });
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
  await connection.close();
});

test('queue byte bound and frame byte bound prevent peer-controlled growth', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const { stream } = await establish(new ClusterClient(connection), socket, 'logs', {
    subscriptionId: 'logs-bytes',
  });
  const message = 'x'.repeat(900_000);
  for (let index = 0; index < 10; index += 1) {
    socket.notify('event', {
      subscriptionId: 'logs-bytes',
      record: { level: 'info', target: 'test', message },
    });
  }
  assert.equal(connection.subscriptionCount, 0);
  assert.ok(stream.retainedCount < SUBSCRIPTION_QUEUE_CAPACITY);
  await stream.cancel();
  socket.emit('message', { data: 'x'.repeat(1_048_577) });
  assert.equal(connection.state, 'OPEN');
  assert.equal(connection.protocolDiagnostics.at(-1).code, 'INVALID_PEER_FRAME');
  await connection.close();
});

test('oversized binary and multibyte ingress is rejected before routing', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const pending = new ClusterClient(connection).get();
  await settle();
  const request = socket.request('get');
  const oversizedFrames = [
    new Uint8Array(MAX_FRAME_BYTES + 1),
    'é'.repeat(Math.floor(MAX_FRAME_BYTES / 2) + 1),
  ];
  for (const data of oversizedFrames) {
    const diagnosticsBefore = connection.protocolDiagnostics.length;
    socket.emit('message', { data });
    assert.equal(connection.state, 'OPEN');
    assert.equal(connection.pendingSize, 1);
    assert.equal(connection.protocolDiagnostics.length, diagnosticsBefore + 1);
    assert.match(connection.protocolDiagnostics.at(-1).message, /frame exceeds/);
  }
  socket.respond(request.id, { status: { phase: 'empty' } });
  await pending;
  await connection.close();
});

test('a terminal overflow frame unregisters without sending cancel', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const { stream } = await establish(new ClusterClient(connection), socket, 'agent/attach', {
    subscriptionId: 'attach-1',
  });
  assert.ok(stream instanceof AgentAttachSubscriptionStream);
  for (let index = 0; index < SUBSCRIPTION_QUEUE_CAPACITY; index += 1)
    socket.notify('event', { subscriptionId: 'attach-1', event: { type: 'working' } });
  socket.notify('subscription/closed', { subscriptionId: 'attach-1', reason: 'done' });
  await settle();
  assert.equal(socket.notifications('subscription/cancel').length, 0);
  assert.equal(connection.subscriptionCount, 0);
  await stream.cancel();
  await connection.close();
});

test('multiple pending next calls are delivered FIFO and all settle on closure', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const { stream } = await establish(new ClusterClient(connection), socket, 'watch', {
    subscriptionId: 'watch-1',
    runId: 'run-1',
  });
  const order = [];
  const pending = [stream.next(), stream.next(), stream.next()].map((promise, index) =>
    promise.then((value) => {
      order.push(index);
      return value;
    })
  );
  socket.notify('event', {
    subscriptionId: 'watch-1',
    runId: 'run-1',
    cursor: '1',
    event: { type: 'bookmark' },
  });
  socket.notify('event', {
    subscriptionId: 'watch-1',
    runId: 'run-1',
    cursor: '2',
    event: { type: 'bookmark' },
  });
  socket.notify('subscription/closed', {
    subscriptionId: 'watch-1',
    reason: 'done',
    lastDeliveredCursor: '2',
  });
  const values = await Promise.all(pending);
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(
    values.map(({ value }) => value.type),
    ['event', 'event', 'closed']
  );
  assert.deepEqual(await Promise.all([stream.next(), stream.next()]), [
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  await connection.close();
});

test('abort cancellation is exact and late subscription successes are reaped', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const controller = new AbortController();
  const pending = new ClusterClient(connection).watch({}, { signal: controller.signal });
  await settle();
  const request = socket.request('watch');
  controller.abort();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(socket.notifications('$/cancelRequest').length, 1);
  socket.respond(request.id, { subscriptionId: 'late-1' });
  await settle();
  assert.deepEqual(
    socket.notifications('subscription/cancel').map(({ params }) => params),
    [{ subscriptionId: 'late-1' }]
  );
  assert.equal(connection.subscriptionCount, 0);
  await connection.close();
});

test('iterator return cancels exactly once and clears retained frames', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const { stream } = await establish(new ClusterClient(connection), socket, 'logs', {
    subscriptionId: 'logs-1',
  });
  socket.notify('event', {
    subscriptionId: 'logs-1',
    record: { level: 'info', target: 'test', message: 'buffered' },
  });
  assert.equal(stream.retainedCount, 1);
  await stream.return();
  await stream.return();
  assert.equal(stream.retainedCount, 0);
  assert.equal(socket.notifications('subscription/cancel').length, 1);
  await connection.close();
});

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

test('default factory rejects headers when only browser WebSocket is available', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class FakeBrowserWS {
    constructor() {
      this.readyState = 0;
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
  try {
    await assert.rejects(
      connect('ws://test', { headers: { Authorization: 'Bearer x' } }),
      (error) => error.code === 'HEADERS_UNSUPPORTED'
    );
  } finally {
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
  }
});

test('close captures bounded code and reason from transport', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  assert.equal(connection.closeCode, undefined);
  assert.equal(connection.closeReason, undefined);
  socket.emit('close', { code: 4001, reason: 'access expired' });
  await settle();
  assert.equal(connection.closeCode, 4001);
  assert.equal(connection.closeReason, 'access expired');

  const socket2 = new FakeWebSocket();
  const connection2 = new Connection(socket2);
  const longReason = 'x'.repeat(200);
  socket2.emit('close', { code: 4002, reason: longReason });
  await settle();
  assert.equal(connection2.closeCode, 4002);
  assert.ok(connection2.closeReason.length <= CLOSE_REASON_MAX_BYTES);
  assert.equal(connection2.closeReason, longReason.slice(0, CLOSE_REASON_MAX_BYTES));

  const socket3 = new FakeWebSocket();
  const connection3 = new Connection(socket3);
  socket3.emit('close', { code: 4003, reason: '€'.repeat(100) });
  await settle();
  assert.equal(Buffer.byteLength(connection3.closeReason, 'utf8'), CLOSE_REASON_MAX_BYTES);
  assert.equal(connection3.closeReason, '€'.repeat(CLOSE_REASON_MAX_BYTES / 3));
});
