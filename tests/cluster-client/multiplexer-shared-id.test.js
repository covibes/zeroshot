'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ClusterClient, ConnectionMultiplexer } = require('../../lib/cluster/cjs/index.js');
const { createFakeSocketPair, sentMessages } = require('./fake-websocket.js');

test('two ClusterClients sharing one ConnectionMultiplexer never collide on request id', async () => {
  const { client: clientSocket, server: serverSocket } = createFakeSocketPair();
  const transport = new ConnectionMultiplexer(clientSocket);
  const clientA = new ClusterClient(transport);
  const clientB = new ClusterClient(transport);

  serverSocket.addEventListener('message', (event) => {
    const request = JSON.parse(event.data);
    if (request.method === 'initialize') {
      serverSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: 'openengine.cluster/v1',
            capabilities: {},
            status: {
              phase: 'empty',
              observedGeneration: null,
              currentRunId: null,
              atCursor: null,
            },
          },
        })
      );
      return;
    }
    if (request.method === 'get') {
      serverSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { status: { phase: 'empty' }, atCursor: null },
        })
      );
    }
  });

  const results = await Promise.all([
    clientA.initialize(),
    clientB.initialize(),
    clientA.get({}),
    clientB.get({}),
    clientA.get({}),
    clientB.get({}),
  ]);

  assert.equal(results.length, 6);
  for (const result of results) assert.ok(result);

  const requests = sentMessages(clientSocket).filter(
    (message) => 'id' in message && 'method' in message
  );
  assert.equal(requests.length, 6);
  const ids = requests.map((request) => request.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `expected unique request ids, got: ${JSON.stringify(ids)}`
  );
});

test('a subscription-establish call mints from the same shared counter as unary calls', async () => {
  const { client: clientSocket, server: serverSocket } = createFakeSocketPair();
  const transport = new ConnectionMultiplexer(clientSocket);
  const client = new ClusterClient(transport);

  serverSocket.addEventListener('message', (event) => {
    const request = JSON.parse(event.data);
    if (request.method === 'get') {
      serverSocket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: { phase: 'empty' } } })
      );
    }
    if (request.method === 'logs') {
      serverSocket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'sub-1' } })
      );
    }
  });

  const [getResult, subscriptionOpen] = await Promise.all([
    client.get({}),
    transport.openSubscription('logs', {}),
  ]);

  assert.ok(getResult);
  assert.equal(subscriptionOpen.subscriptionId, 'sub-1');

  const requests = sentMessages(clientSocket).filter(
    (message) => 'id' in message && 'method' in message
  );
  const ids = requests.map((request) => request.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `expected unique request ids, got: ${JSON.stringify(ids)}`
  );
});
