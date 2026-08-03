'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  HostedAuthenticationError,
  HostedAuthorizationError,
  HostedSessionCoordinator,
  HostedTransportUncertainError,
} = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');

function makeAccess(token = 'test-bearer-token', overrides = {}) {
  return {
    protocol: 'openengine.cluster/v1',
    websocketUrl: 'wss://hosted.example/v1/capsules/cap-1/oecp',
    accessToken: token,
    tokenType: 'Bearer',
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
    void (async () => {
      await settle();
      const request = socket.request('initialize');
      if (request) {
        socket.respond(request.id, {
          protocolVersion: 'openengine.cluster/v1',
          capabilities:
            typeof capabilities === 'function' ? capabilities(sockets.length - 1) : capabilities,
          status: { phase: 'running' },
        });
      }
    })();
    return socket;
  };
  return { factory, capturedHeaders, capturedUrls, sockets };
}

async function waitForRequest(socket, method) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = socket.request(method);
    if (request) return request;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method} request`);
}

async function waitForSocket(sockets, index) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (sockets[index]) return sockets[index];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for socket ${index}`);
}

function makeCoordinator(factory, accesses = [makeAccess()]) {
  let index = 0;
  return new HostedSessionCoordinator({
    adapter: { access: () => Promise.resolve(accesses[index++]) },
    capsuleId: 'cap-1',
    targetAuthority: 'https://hosted.example',
    connectOptions: { webSocketFactory: factory },
  });
}

describe('HostedSessionCoordinator', () => {
  it('mints fresh access for every authenticated open and replacement', async () => {
    const fixture = autoRespondFactory();
    const coordinator = makeCoordinator(fixture.factory, [
      makeAccess('token-one'),
      makeAccess('token-two'),
    ]);
    const first = await coordinator.open();
    const second = await coordinator.replace();

    assert.deepEqual(fixture.capturedHeaders, [
      { Authorization: 'Bearer token-one' },
      { Authorization: 'Bearer token-two' },
    ]);
    assert.equal(
      fixture.capturedUrls.every((url) => !url.includes('token-')),
      true
    );
    await first.connection.close();
    await second.connection.close();
    await coordinator.close();
  });

  it('rejects access grants whose WSS authority differs before socket creation', async () => {
    let calls = 0;
    const coordinator = makeCoordinator(() => {
      calls += 1;
      return new FakeWebSocket();
    }, [makeAccess('token', { websocketUrl: 'wss://attacker.example/v1/capsules/cap-1/oecp' })]);
    await assert.rejects(coordinator.open(), { code: 'INVALID_ACCESS_ENDPOINT' });
    assert.equal(calls, 0);
  });

  it('maps a bodyless pre-upgrade 401 to authentication failure', async () => {
    const socket = new FakeWebSocket({ open: false });
    const coordinator = makeCoordinator(() => {
      setImmediate(() => socket.emit('unexpected-response', { statusCode: 401 }));
      return socket;
    });
    await assert.rejects(coordinator.open(), HostedAuthenticationError);
    assert.equal(socket.closeCalls, 1);
  });

  it('accepts a capability superset and closes a regressed replacement', async () => {
    const fixture = autoRespondFactory((index) =>
      index === 0
        ? BASE_CAPS
        : {
            logs: false,
            agentAttach: true,
            graphProfiles: ['openengine.graph.full/v1'],
          }
    );
    const coordinator = makeCoordinator(fixture.factory, [makeAccess('one'), makeAccess('two')]);
    const original = await coordinator.open();
    await assert.rejects(coordinator.replace(), { code: 'CAPABILITY_REGRESSION' });
    await settle();
    assert.equal(fixture.sockets[1].closeCalls, 1);
    await original.connection.close();
    await coordinator.close();
  });

  it('reconnects a live watch once with a fresh grant and the stream-owned cursor', async () => {
    const sockets = [];
    const tokens = [];
    let access = 0;
    const coordinator = new HostedSessionCoordinator({
      adapter: {
        access: () => {
          const token = `fresh-${++access}`;
          tokens.push(token);
          return Promise.resolve(makeAccess(token));
        },
      },
      capsuleId: 'cap-1',
      targetAuthority: 'https://hosted.example',
      connectOptions: {
        webSocketFactory: (_url, _protocols, options) => {
          tokens.push(options.headers.Authorization);
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    const opening = coordinator.watch({ params: {} });
    await settle();
    const firstInitialize = await waitForRequest(sockets[0], 'initialize');
    sockets[0].respond(firstInitialize.id, {
      protocolVersion: 'openengine.cluster/v1',
      capabilities: BASE_CAPS,
      status: { phase: 'running' },
    });
    await settle();
    sockets[0].respond((await waitForRequest(sockets[0], 'watch')).id, {
      subscriptionId: 'watch-1',
      runId: 'run-1',
    });
    const watch = await opening;
    const first = watch.next();
    sockets[0].notify('event', {
      subscriptionId: 'watch-1',
      runId: 'run-1',
      cursor: 'cursor-1',
      event: { type: 'bookmark' },
    });
    assert.equal((await first).value.cursor, 'cursor-1');

    const replacementEvent = watch.next();
    sockets[0].readyState = 3;
    sockets[0].emit('close', { code: 4401, reason: '' });
    await settle();
    const secondSocket = await waitForSocket(sockets, 1);
    const secondInitialize = await waitForRequest(secondSocket, 'initialize');
    sockets[1].respond(secondInitialize.id, {
      protocolVersion: 'openengine.cluster/v1',
      capabilities: BASE_CAPS,
      status: { phase: 'running' },
    });
    await settle();
    const reconnectRequest = await waitForRequest(sockets[1], 'watch');
    assert.deepEqual(reconnectRequest.params, { runId: 'run-1', fromCursor: 'cursor-1' });
    sockets[1].respond(reconnectRequest.id, { subscriptionId: 'watch-2', runId: 'run-1' });
    await settle();
    sockets[1].notify('event', {
      subscriptionId: 'watch-2',
      runId: 'run-1',
      cursor: 'cursor-2',
      event: { type: 'bookmark' },
    });
    assert.equal((await replacementEvent).value.cursor, 'cursor-2');
    assert.deepEqual(tokens, ['fresh-1', 'Bearer fresh-1', 'fresh-2', 'Bearer fresh-2']);
    const exhaustedReplacement = watch.next();
    sockets[1].readyState = 3;
    sockets[1].emit('close', { code: 4401, reason: '' });
    await assert.rejects(exhaustedReplacement, HostedTransportUncertainError);
    assert.equal(sockets.length, 2);
    await watch.cancel();
    await coordinator.close();
  });
});

describe('HostedSessionCoordinator close classification', () => {
  for (const [code, ErrorType] of [
    [4403, HostedAuthorizationError],
    [4500, HostedTransportUncertainError],
  ]) {
    it(`classifies established ${code} without reconnecting`, async () => {
      const fixture = autoRespondFactory();
      const coordinator = makeCoordinator(fixture.factory);
      const opening = coordinator.watch({ params: {} });
      const socket = await waitForSocket(fixture.sockets, 0);
      socket.respond((await waitForRequest(socket, 'watch')).id, {
        subscriptionId: 'watch-terminal',
        runId: 'run-terminal',
      });
      const watch = await opening;
      const pending = watch.next();
      socket.readyState = 3;
      socket.emit('close', { code, reason: '' });

      await assert.rejects(pending, ErrorType);
      assert.equal(fixture.sockets.length, 1);
      await coordinator.close();
    });
  }

  it('close aborts in-progress access and rejects later opens', async () => {
    const coordinator = new HostedSessionCoordinator({
      adapter: {
        access: (capsuleId, signal) =>
          new Promise((_resolve, reject) => {
            assert.equal(capsuleId, 'cap-1');
            signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            );
          }),
      },
      capsuleId: 'cap-1',
      targetAuthority: 'https://hosted.example',
    });
    const pending = coordinator.open();
    await settle();
    await coordinator.close();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(coordinator.open(), { code: 'COORDINATOR_CLOSED' });
  });
});
