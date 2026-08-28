'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AgentAttachSubscriptionStream,
  ClusterClient,
  Connection,
  LogsSubscriptionStream,
  MAX_FRAME_BYTES,
  SUBSCRIPTION_QUEUE_CAPACITY,
} = require('../../lib/cluster/index.cjs');
const { FakeWebSocket, assertClean, establish, settle } = require('./harness');

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

test('legacy run sizes are normalized only on inbound projections', async () => {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  const projection = (runId, size) => ({
    runId,
    title: 'Legacy run',
    source: { repository: 'owner/repo', revision: 'a'.repeat(40), branch: 'main' },
    size,
    atCursor: 'cursor-1',
    status: { phase: 'admitted' },
  });

  const statusPending = connection.call('run/status', { runId: 'run-tiny' });
  await settle();
  socket.respond(socket.request('run/status').id, projection('run-tiny', 'tiny'));
  assert.equal((await statusPending).size, 'small');

  const forcePending = connection.call('run/force', { runId: 'run-standard' });
  await settle();
  socket.respond(socket.request('run/force').id, projection('run-standard', 'standard'));
  assert.equal((await forcePending).size, 'medium');

  const listPending = connection.call('run/list', {});
  await settle();
  socket.respond(socket.request('run/list').id, {
    runs: [projection('run-list-tiny', 'tiny'), projection('run-list-standard', 'standard')],
  });
  assert.deepEqual(
    (await listPending).runs.map(({ size }) => size),
    ['small', 'medium']
  );

  const watchPending = connection.openSubscription('run/watch', { runId: 'run-watch' });
  await settle();
  socket.respond(socket.request('run/watch').id, {
    subscriptionId: 'run-watch-subscription',
    runId: 'run-watch',
    atCursor: 'cursor-0',
  });
  const watch = await watchPending;
  const legacyWatch = projection('run-watch', 'tiny');
  socket.notify('event', {
    subscriptionId: 'run-watch-subscription',
    runId: legacyWatch.runId,
    title: legacyWatch.title,
    source: legacyWatch.source,
    size: legacyWatch.size,
    cursor: 'cursor-1',
    status: legacyWatch.status,
  });
  const queued = await watch.registration.queue.recv();
  assert.equal(queued.done, false);
  assert.equal(queued.value.params.size, 'small');
  await connection.cancelSubscription(watch.registration);
  connection.unregisterSubscription(watch.registration.id, watch.registration);
  await connection.close();
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
