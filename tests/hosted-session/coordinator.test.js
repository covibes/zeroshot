'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  HostedAuthenticationError,
  HostedSessionCoordinator,
  HostedTransportUncertainError,
} = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');
const {
  BASE_CAPS,
  autoRespondFactory,
  makeAccess,
  makeCoordinator,
  waitForRequest,
  waitForSocket,
} = require('./harness');

function reconnectFixture() {
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
  return { coordinator, sockets, tokens };
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

  it('defaults omitted graph profile capabilities to empty during replacement', async () => {
    const fixture = autoRespondFactory({});
    const coordinator = makeCoordinator(fixture.factory, [makeAccess('one'), makeAccess('two')]);
    const original = await coordinator.open();
    const replacement = await coordinator.replace();
    await original.connection.close();
    await replacement.connection.close();
    await coordinator.close();
  });
});

describe('HostedSessionCoordinator authority validation', () => {
  it('allows only exact literal-loopback HTTP and WS authorities', async () => {
    const fixture = autoRespondFactory({});
    const coordinator = new HostedSessionCoordinator({
      adapter: {
        access: () =>
          Promise.resolve(
            makeAccess('loopback', {
              websocketUrl: 'ws://127.0.0.1:8080/v1/capsules/cap-1/oecp',
            })
          ),
      },
      capsuleId: 'cap-1',
      targetAuthority: 'http://127.0.0.1:8080',
      connectOptions: { webSocketFactory: fixture.factory },
    });
    const session = await coordinator.open();
    assert.deepEqual(fixture.capturedUrls, ['ws://127.0.0.1:8080/v1/capsules/cap-1/oecp']);
    await session.connection.close();
    await coordinator.close();
  });
});

describe('HostedSessionCoordinator reconnect', () => {
  it('reconnects a live watch once with a fresh grant and the stream-owned cursor', async () => {
    const { coordinator, sockets, tokens } = reconnectFixture();

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
    const concurrentReplacementEvent = watch.next();
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
    sockets[1].notify('event', {
      subscriptionId: 'watch-2',
      runId: 'run-1',
      cursor: 'cursor-3',
      event: { type: 'bookmark' },
    });
    assert.equal((await replacementEvent).value.cursor, 'cursor-2');
    assert.equal((await concurrentReplacementEvent).value.cursor, 'cursor-3');
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
