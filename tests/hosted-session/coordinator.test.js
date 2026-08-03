'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { HostedSessionCoordinator } = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');

function makeAccess(overrides = {}) {
  return {
    endpoint: 'wss://test-cluster',
    token: 'test-bearer-token',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

const BASE_CAPS = {
  logs: true,
  agentAttach: true,
  graphProfiles: ['openengine.graph.full/v1'],
};

function autoRespondFactory(capabilities = BASE_CAPS) {
  const capturedHeaders = [];
  const capturedUrls = [];
  const sockets = [];
  const factory = (url, _protocols, options) => {
    capturedUrls.push(url);
    capturedHeaders.push(options?.headers);
    const socket = new FakeWebSocket();
    sockets.push(socket);
    const respond = async () => {
      await settle();
      const initReq = socket.sent.find((frame) => frame.method === 'initialize');
      if (initReq) {
        socket.respond(initReq.id, {
          protocolVersion: 'openengine.cluster/v1',
          capabilities:
            typeof capabilities === 'function' ? capabilities(sockets.length - 1) : capabilities,
          status: { phase: 'running' },
        });
      }
    };
    void respond();
    return socket;
  };
  return { factory, capturedHeaders, capturedUrls, sockets };
}

function makeCoordinator(factory, access = makeAccess()) {
  return new HostedSessionCoordinator({
    getAccess: () => Promise.resolve(access),
    connectOptions: { webSocketFactory: factory },
  });
}

describe('HostedSessionCoordinator', () => {
  it('computes the bounded renewal deadline from real coordinator code', () => {
    const coordinator = new HostedSessionCoordinator({
      getAccess: () => Promise.resolve(makeAccess()),
    });
    const receivedAt = 1_000_000;
    const expiresAtMs = receivedAt + 300_000;
    const access = makeAccess({ expiresAt: new Date(expiresAtMs).toISOString() });

    assert.equal(
      coordinator.renewalDeadline(access, receivedAt),
      Math.min(expiresAtMs - 30_000, receivedAt + 0.8 * 300_000)
    );
  });

  it('rejects an invalid expiry in renewal calculations', () => {
    const coordinator = new HostedSessionCoordinator({
      getAccess: () => Promise.resolve(makeAccess()),
    });
    assert.throws(
      () =>
        coordinator.renewalDeadline(
          { endpoint: 'wss://test', token: 'token', expiresAt: 'not-a-date' },
          0
        ),
      { code: 'INVALID_EXPIRY' }
    );
  });

  it('opens authenticated initialized sessions without placing tokens in URLs', async () => {
    const token = 'super-secret-token-123';
    const { factory, capturedHeaders, capturedUrls } = autoRespondFactory();
    const coordinator = makeCoordinator(factory, makeAccess({ token }));

    const session = await coordinator.open();

    assert.equal(capturedUrls[0], 'wss://test-cluster/');
    assert.ok(!capturedUrls[0].includes(token));
    assert.deepEqual(capturedHeaders[0], { Authorization: `Bearer ${token}` });
    await session.connection.close();
    await coordinator.close();
  });

  it('rejects plaintext and malformed hosted endpoints before opening a socket', async () => {
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls += 1;
      return new FakeWebSocket();
    };
    const plaintext = makeCoordinator(factory, makeAccess({ endpoint: 'ws://test-cluster' }));
    await assert.rejects(plaintext.open(), { code: 'INSECURE_ENDPOINT' });
    const malformed = makeCoordinator(factory, makeAccess({ endpoint: 'not a URL' }));
    await assert.rejects(malformed.open(), { code: 'INVALID_ENDPOINT' });
    assert.equal(factoryCalls, 0);
  });

  it('rejects already-expired access before opening a socket', async () => {
    let factoryCalls = 0;
    const coordinator = makeCoordinator(
      () => {
        factoryCalls += 1;
        return new FakeWebSocket();
      },
      makeAccess({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
    );

    await assert.rejects(coordinator.open(), { code: 'ACCESS_EXPIRED' });
    assert.equal(factoryCalls, 0);
  });

  it('accepts a replacement whose capabilities are a superset', async () => {
    const { factory } = autoRespondFactory((index) =>
      index === 0
        ? BASE_CAPS
        : {
            ...BASE_CAPS,
            graphProfiles: ['openengine.graph.full/v1', 'openengine.graph.single-worker/v1'],
          }
    );
    const coordinator = makeCoordinator(factory);
    const original = await coordinator.open();
    const replacement = await coordinator.replace();

    await original.connection.close();
    await replacement.connection.close();
    await coordinator.close();
  });

  it('closes and rejects an incompatible replacement connection', async () => {
    const { factory, sockets } = autoRespondFactory((index) =>
      index === 0 ? BASE_CAPS : { graphProfiles: ['openengine.graph.full/v1'] }
    );
    const coordinator = makeCoordinator(factory);
    const original = await coordinator.open();

    await assert.rejects(coordinator.replace(), { code: 'INCOMPATIBLE_CAPABILITIES' });
    await settle();
    assert.equal(sockets[1].closeCalls, 1);
    await original.connection.close();
    await coordinator.close();
  });

  it('close aborts an in-progress access request and prevents later opens', async () => {
    const coordinator = new HostedSessionCoordinator({
      getAccess: (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        }),
    });
    const pending = coordinator.open();
    await settle();

    await coordinator.close();

    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(coordinator.open(), { code: 'COORDINATOR_CLOSED' });
  });
});
