'use strict';

const { HostedSessionCoordinator } = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');
const { waitForSocketRequest: waitForRequest } = require('../helpers/wait-for-socket-request');

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

module.exports = {
  BASE_CAPS,
  autoRespondFactory,
  makeAccess,
  makeCoordinator,
  waitForRequest,
  waitForSocket,
};
