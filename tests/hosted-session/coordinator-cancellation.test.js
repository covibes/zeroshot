'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  HostedAuthorizationError,
  HostedSessionCoordinator,
  HostedTransportUncertainError,
} = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');
const {
  autoRespondFactory,
  makeAccess,
  makeCoordinator,
  waitForRequest,
  waitForSocket,
} = require('./harness');

describe('HostedSessionCoordinator cancellation', () => {
  it('closes the session when cancellation lands as watch setup completes', async () => {
    const fixture = autoRespondFactory({});
    const coordinator = makeCoordinator(fixture.factory);
    const controller = new AbortController();
    const opening = coordinator.watch({ params: {}, signal: controller.signal });
    await settle();
    const socket = fixture.sockets[0];
    socket.respond((await waitForRequest(socket, 'watch')).id, {
      subscriptionId: 'watch-1',
      runId: 'run-1',
    });
    controller.abort(new globalThis.DOMException('cancelled', 'AbortError'));
    await assert.rejects(opening, /cancelled|abort/i);
    await settle();
    assert.equal(socket.closeCalls, 1);
    await coordinator.close();
  });

  it('aborts and awaits an in-flight watch replacement during cancellation', async () => {
    const sockets = [];
    let replacementSignal;
    let accesses = 0;
    const coordinator = new HostedSessionCoordinator({
      adapter: {
        access: (_capsuleId, signal) => {
          accesses += 1;
          if (accesses === 1) return Promise.resolve(makeAccess());
          replacementSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
      capsuleId: 'cap-1',
      targetAuthority: 'https://hosted.example',
      connectOptions: {
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    const opening = coordinator.watch({ params: {} });
    await settle();
    sockets[0].respond((await waitForRequest(sockets[0], 'initialize')).id, {
      protocolVersion: 'openengine.cluster/v1',
      capabilities: {},
      status: { phase: 'running' },
    });
    sockets[0].respond((await waitForRequest(sockets[0], 'watch')).id, {
      subscriptionId: 'watch-1',
      runId: 'run-1',
    });
    const watch = await opening;
    const pending = watch.next();
    sockets[0].readyState = 3;
    sockets[0].emit('close', { code: 4401, reason: 'peer canary' });
    for (let attempt = 0; attempt < 20 && replacementSignal === undefined; attempt += 1) {
      await settle();
    }
    assert.ok(replacementSignal);
    await watch.cancel();
    assert.equal(replacementSignal.aborted, true);
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(sockets.length, 1);
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
