'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterClient,
  ConnectionMultiplexer,
  LogsSubscriptionStream,
} = require('../../lib/cluster/cjs/index.js');
const {
  createFakeSocketPair,
  respondSuccess,
  sentMessages,
  waitForRequest,
} = require('./fake-websocket.js');

test('aborting a unary call sends exactly one $/cancelRequest and rejects once with AbortError', async () => {
  const { client: clientSocket, server: serverSocket } = createFakeSocketPair();
  const transport = new ConnectionMultiplexer(clientSocket);
  const client = new ClusterClient(transport);
  const controller = new AbortController();

  const requestSeen = waitForRequest(serverSocket, 'get');
  const callPromise = client.get({}, { signal: controller.signal });
  const request = await requestSeen;

  controller.abort();

  await assert.rejects(callPromise, (error) => error.name === 'AbortError');

  // A late server response for the already-aborted id must be a silent no-op.
  assert.doesNotThrow(() => {
    respondSuccess(serverSocket, request.id, { status: { phase: 'empty' } });
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cancelNotifications = sentMessages(clientSocket).filter(
    (m) => m.method === '$/cancelRequest'
  );
  assert.equal(cancelNotifications.length, 1);
  assert.equal(cancelNotifications[0].params.id, request.id);
});

test('an already-aborted signal rejects before sending the request', async () => {
  const { client: clientSocket } = createFakeSocketPair();
  const transport = new ConnectionMultiplexer(clientSocket);
  const client = new ClusterClient(transport);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.get({}, { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(clientSocket.sent.length, 0);
});

test('subscription cancel() and the iterator return() invoked concurrently send exactly one subscription/cancel', async () => {
  const { client: clientSocket, server: serverSocket } = createFakeSocketPair();
  const transport = new ConnectionMultiplexer(clientSocket);

  const establishPromise = transport.openSubscription('logs', {});
  const establishRequest = await waitForRequest(serverSocket, 'logs');
  respondSuccess(serverSocket, establishRequest.id, { subscriptionId: 'sub-9' });
  const opened = await establishPromise;
  const stream = new LogsSubscriptionStream(opened.subscriptionId, transport, opened.deliveries);

  const iterator = stream[Symbol.asyncIterator]();
  await Promise.all([stream.cancel(), iterator.return()]);
  await stream.cancel(); // a third, later call must still be a no-op

  const cancelNotifications = sentMessages(clientSocket).filter(
    (m) => m.method === 'subscription/cancel'
  );
  assert.equal(cancelNotifications.length, 1);
  assert.equal(cancelNotifications[0].params.subscriptionId, 'sub-9');
});
