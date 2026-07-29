'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ClusterClient,
  ClusterProtocolError,
  Connection,
  UNARY_METHODS,
  PROTOCOL_DIAGNOSTIC_CAPACITY,
  connect,
} = require('../../lib/cluster/index.cjs');
const { FakeWebSocket, settle } = require('./harness');

const SUBSCRIPTIONS = [
  {
    method: 'watch',
    invoke: (client, options) => client.watch({}, options),
    result: { subscriptionId: 'watch-abort', runId: 'run-1' },
  },
  {
    method: 'logs',
    invoke: (client, options) => client.logs({}, options),
    result: { subscriptionId: 'logs-abort' },
  },
  {
    method: 'agent/attach',
    invoke: (client, options) => client.agentAttach({ execution: 'exec-1' }, options),
    result: { subscriptionId: 'attach-abort' },
  },
];

test('subscription signals survive every response handoff and cancel exactly once', async () => {
  for (const descriptor of SUBSCRIPTIONS) {
    const socket = new FakeWebSocket();
    const connection = new Connection(socket);
    const client = new ClusterClient(connection);
    const controller = new AbortController();
    const opening = descriptor.invoke(client, { signal: controller.signal });
    await settle();
    socket.respond(socket.request(descriptor.method).id, descriptor.result);
    controller.abort();
    const { stream } = await opening;
    assert.equal(connection.subscriptionCount, 0, descriptor.method);
    assert.deepEqual(await stream.next(), { done: true, value: undefined }, descriptor.method);
    await settle();
    assert.equal(socket.notifications('subscription/cancel').length, 1, descriptor.method);
    await stream.cancel();
    assert.equal(socket.notifications('subscription/cancel').length, 1, descriptor.method);
    await connection.close();
  }
});

test('watch serializes logical reads so dedup cannot reverse concurrent callers', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const opening = new ClusterClient(connection).watch({});
  await settle();
  socket.respond(socket.request('watch').id, { subscriptionId: 'ordered-watch', runId: 'run-1' });
  const { stream } = await opening;
  socket.notify('event', {
    subscriptionId: 'ordered-watch',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  assert.equal((await stream.next()).value.cursor, 'cursor-1');

  const first = stream.next();
  const second = stream.next();
  socket.notify('event', {
    subscriptionId: 'ordered-watch',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  socket.notify('event', {
    subscriptionId: 'ordered-watch',
    runId: 'run-1',
    cursor: 'cursor-2',
    event: { type: 'bookmark' },
  });
  socket.notify('subscription/closed', {
    subscriptionId: 'ordered-watch',
    reason: 'done',
    lastDeliveredCursor: 'cursor-2',
  });
  assert.equal((await first).value.cursor, 'cursor-2');
  assert.deepEqual((await second).value, {
    type: 'closed',
    reason: 'done',
    lastDeliveredCursor: 'cursor-2',
  });
  await connection.close();
});

test('watch dedup state remains bounded across many unique events', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const opening = new ClusterClient(connection).watch({});
  await settle();
  socket.respond(socket.request('watch').id, {
    subscriptionId: 'bounded-dedup',
    runId: 'run-1',
  });
  const { stream } = await opening;
  for (let index = 0; index < 4_096; index += 1) {
    socket.notify('event', {
      subscriptionId: 'bounded-dedup',
      runId: 'run-1',
      cursor: `cursor-${index}`,
      event: { type: 'bookmark' },
    });
    assert.equal((await stream.next()).value.cursor, `cursor-${index}`);
    assert.equal(stream.retainedCount, 0);
  }
  await stream.cancel();
  await connection.close();
});

test('authoritative schemas reject every malformed unary and establishment result', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  for (const method of UNARY_METHODS) {
    const invalid = connection.call(method, {});
    await settle();
    socket.respond(socket.request(method).id, { garbage: true });
    await assert.rejects(invalid, (error) => error instanceof ClusterProtocolError, method);
  }

  for (const descriptor of SUBSCRIPTIONS) {
    const leakedId = `leaked-${descriptor.method}`;
    const invalid = descriptor.invoke(new ClusterClient(connection));
    await settle();
    const invalidResult =
      descriptor.method === 'watch'
        ? { subscriptionId: leakedId, runId: 7 }
        : { subscriptionId: leakedId, unexpected: true };
    socket.respond(socket.request(descriptor.method).id, invalidResult);
    await assert.rejects(
      invalid,
      (error) => error instanceof ClusterProtocolError,
      descriptor.method
    );
    await settle();
    assert.deepEqual(socket.notifications('subscription/cancel').at(-1).params, {
      subscriptionId: leakedId,
    });
    assert.equal(connection.subscriptionCount, 0);
  }
  assert.equal(socket.notifications('subscription/cancel').length, SUBSCRIPTIONS.length);
  await connection.close();
});

test('authoritative JSON-RPC error envelopes reject noninteger codes and malformed data', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const client = new ClusterClient(connection);
  for (const error of [
    { code: -32000.5, message: 'fractional code' },
    { code: -32000, message: 'bad data', data: { code: 7 } },
  ]) {
    const pending = client.get();
    await settle();
    const { id } = socket.request(
      'get',
      socket.sent.filter((frame) => frame.method === 'get' && 'id' in frame).length - 1
    );
    socket.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, error }),
    });
    await assert.rejects(
      pending,
      (cause) => cause instanceof ClusterProtocolError && cause.code === 'INVALID_RESPONSE'
    );
  }
  await connection.close();
});

test('authoritative schemas reject wrong subscription event fields', async () => {
  const cases = [
    {
      method: 'watch',
      invoke: (client) => client.watch({}),
      result: { subscriptionId: 'invalid-watch', runId: 'run-1' },
      params: { subscriptionId: 'invalid-watch', runId: 'run-1', cursor: 'cursor-1', event: {} },
    },
    {
      method: 'logs',
      invoke: (client) => client.logs({}),
      result: { subscriptionId: 'invalid-logs' },
      params: { subscriptionId: 'invalid-logs', record: {} },
    },
    {
      method: 'agent/attach',
      invoke: (client) => client.agentAttach({ execution: 'exec-1' }),
      result: { subscriptionId: 'invalid-attach' },
      params: { subscriptionId: 'invalid-attach', event: {} },
    },
  ];
  for (const descriptor of cases) {
    const socket = new FakeWebSocket();
    const connection = new Connection(socket);
    const opening = descriptor.invoke(new ClusterClient(connection));
    await settle();
    socket.respond(socket.request(descriptor.method).id, descriptor.result);
    const { stream } = await opening;
    socket.notify('event', descriptor.params);
    await assert.rejects(
      stream.next(),
      (error) => error instanceof ClusterProtocolError,
      descriptor.method
    );
    assert.equal(connection.subscriptionCount, 0, descriptor.method);
    await connection.close();
  }
});
test('watch close payload is validated before it becomes caller-visible', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const opening = new ClusterClient(connection).watch({});
  await settle();
  socket.respond(socket.request('watch').id, { subscriptionId: 'invalid-watch-close' });
  const { stream } = await opening;
  socket.notify('subscription/closed', {
    subscriptionId: 'invalid-watch-close',
    reason: 'not-a-close-reason',
  });
  await assert.rejects(stream.next(), (error) => error instanceof ClusterProtocolError);
  await connection.close();
});

test('cursorless subscriptions reject watch-only close cursor fields', async () => {
  for (const descriptor of [
    { method: 'logs', invoke: (client) => client.logs({}), id: 'logs-close' },
    {
      method: 'agent/attach',
      invoke: (client) => client.agentAttach({ execution: 'exec-1' }),
      id: 'attach-close',
    },
  ]) {
    const socket = new FakeWebSocket();
    const connection = new Connection(socket);
    const opening = descriptor.invoke(new ClusterClient(connection));
    await settle();
    socket.respond(socket.request(descriptor.method).id, { subscriptionId: descriptor.id });
    const { stream } = await opening;
    socket.notify('subscription/closed', {
      subscriptionId: descriptor.id,
      reason: 'done',
      lastDeliveredCursor: 'forbidden',
    });
    await assert.rejects(
      stream.next(),
      (error) => error instanceof ClusterProtocolError,
      descriptor.method
    );
    await connection.close();
  }
});

test('public runtime request surface cannot bypass method and cancellation ownership', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  assert.equal(connection.sendNotification, undefined);
  assert.throws(() => connection.call('watch', {}), { code: 'INVALID_METHOD' });
  assert.throws(() => connection.openSubscription('get', {}), { code: 'INVALID_METHOD' });
  await assert.rejects(connection.cancelSubscription({ id: 'guessed', cancelSent: false }), {
    code: 'UNOWNED_SUBSCRIPTION',
  });
  assert.equal(socket.sent.length, 0);
  await connection.close();
});

test('connect rejects already-closing and closed sockets without installing waiters', async () => {
  for (const readyState of [2, 3]) {
    const socket = new FakeWebSocket({ open: false });
    socket.readyState = readyState;
    await assert.rejects(connect('ws://example', { webSocketFactory: () => socket }), {
      code: 'OPEN_FAILED',
    });
    assert.equal([...socket.listeners.values()].flat().length, 0);
    assert.equal(socket.closeCalls, 1);
  }
});

test('malformed-frame diagnostics retain a fixed-capacity recent window', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  for (let index = 0; index < 10_000; index += 1) {
    socket.emit('message', { data: '{' });
  }
  assert.equal(connection.protocolDiagnostics.length, PROTOCOL_DIAGNOSTIC_CAPACITY);
  assert.equal(connection.state, 'OPEN');
  await connection.close();
});
