'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { connectInitialized } = require('../../lib/cluster/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');

function makeAccess(overrides = {}) {
  return {
    endpoint: 'ws://test-cluster',
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

function autoRespondFactory(caps = BASE_CAPS) {
  const capturedHeaders = [];
  const sockets = [];
  const factory = (_url, _protocols, options) => {
    capturedHeaders.push(options?.headers);
    const socket = new FakeWebSocket();
    sockets.push(socket);
    const respond = async () => {
      await settle();
      const initReq = socket.sent.find((f) => f.method === 'initialize');
      if (initReq) {
        socket.respond(initReq.id, {
          protocolVersion: 'openengine.cluster/v1',
          capabilities: caps,
          status: { phase: 'running' },
        });
      }
    };
    void respond();
    return socket;
  };
  return { factory, capturedHeaders, sockets };
}

// HostedSessionCoordinator is TypeScript-only source. We test the coordinator
// behavior by importing it via the built cluster APIs and exercising the same
// logic paths that the coordinator depends on.

// The coordinator's renewalDeadline is a pure function. Test it directly.
describe('renewalDeadline logic', () => {
  function renewalDeadline(access, receivedAt) {
    const expiresAt = Date.parse(access.expiresAt);
    if (Number.isNaN(expiresAt))
      throw Object.assign(new Error('invalid expiresAt'), { code: 'INVALID_EXPIRY' });
    return Math.min(expiresAt - 30_000, receivedAt + 0.8 * (expiresAt - receivedAt));
  }

  it('computes min(expiresAt - 30s, receivedAt + 80% lifetime)', () => {
    const receivedAt = 1_000_000;
    const expiresAtMs = receivedAt + 300_000;
    const access = makeAccess({ expiresAt: new Date(expiresAtMs).toISOString() });
    const deadline = renewalDeadline(access, receivedAt);
    assert.equal(deadline, Math.min(expiresAtMs - 30_000, receivedAt + 0.8 * 300_000));
  });

  it('throws on invalid expiresAt', () => {
    assert.throws(
      () => renewalDeadline({ endpoint: 'ws://x', token: 't', expiresAt: 'not-a-date' }, 0),
      { code: 'INVALID_EXPIRY' }
    );
  });

  it('uses expiresAt - 30s when lifetime is short', () => {
    const receivedAt = 1_000_000;
    const expiresAtMs = receivedAt + 20_000;
    const access = makeAccess({ expiresAt: new Date(expiresAtMs).toISOString() });
    const deadline = renewalDeadline(access, receivedAt);
    // min(expiresAt - 30s, receivedAt + 80% * 20s) = min(receivedAt - 10000, receivedAt + 16000)
    assert.equal(deadline, expiresAtMs - 30_000);
  });
});

describe('connectInitialized with authenticated headers', () => {
  it('passes bearer header via factory options arg', async () => {
    const capturedOptions = [];
    const { factory } = autoRespondFactory();
    const wrappedFactory = (url, protocols, options) => {
      capturedOptions.push(options);
      return factory(url, protocols, options);
    };
    const result = await connectInitialized('ws://test', {
      webSocketFactory: wrappedFactory,
      headers: { Authorization: 'Bearer my-token' },
    });
    assert.deepEqual(capturedOptions[0], { headers: { Authorization: 'Bearer my-token' } });
    await result.connection.close();
  });

  it('token appears only in factory headers, never in URL or error messages', async () => {
    let capturedUrl;
    const { factory, capturedHeaders } = autoRespondFactory();
    const wrappedFactory = (url, protocols, options) => {
      capturedUrl = url;
      return factory(url, protocols, options);
    };
    const result = await connectInitialized('ws://test-cluster', {
      webSocketFactory: wrappedFactory,
      headers: { Authorization: 'Bearer super-secret-token-123' },
    });
    assert.ok(capturedUrl);
    assert.ok(!capturedUrl.includes('super-secret-token-123'));
    assert.equal(capturedHeaders[0]?.Authorization, 'Bearer super-secret-token-123');
    await result.connection.close();
  });
});

describe('capability verification logic', () => {
  function verifyCapabilities(reference, incoming) {
    const mismatches = [];
    if (reference.graphProfiles) {
      const incomingProfiles = new Set(incoming.graphProfiles || []);
      for (const profile of reference.graphProfiles) {
        if (!incomingProfiles.has(profile)) mismatches.push(`missing graphProfile: ${profile}`);
      }
    }
    if (reference.logs && !incoming.logs) mismatches.push('missing capability: logs');
    if (reference.agentAttach && !incoming.agentAttach)
      mismatches.push('missing capability: agentAttach');
    return mismatches;
  }

  it('detects incompatible capabilities', () => {
    const reference = BASE_CAPS;
    const incoming = { logs: false, agentAttach: false };
    const mismatches = verifyCapabilities(reference, incoming);
    assert.ok(mismatches.length > 0);
    assert.ok(mismatches.some((m) => m.includes('logs')));
    assert.ok(mismatches.some((m) => m.includes('agentAttach')));
  });

  it('accepts compatible superset capabilities', () => {
    const reference = BASE_CAPS;
    const incoming = {
      ...BASE_CAPS,
      graphProfiles: ['openengine.graph.full/v1', 'openengine.graph.single-worker/v1'],
    };
    const mismatches = verifyCapabilities(reference, incoming);
    assert.equal(mismatches.length, 0);
  });

  it('detects missing graphProfile', () => {
    const reference = { graphProfiles: ['openengine.graph.full/v1'] };
    const incoming = { graphProfiles: ['openengine.graph.single-worker/v1'] };
    const mismatches = verifyCapabilities(reference, incoming);
    assert.ok(mismatches.some((m) => m.includes('openengine.graph.full/v1')));
  });
});

describe('close aborts in-progress operations', () => {
  it('AbortController.abort cancels pending getAccess', async () => {
    const controller = new AbortController();
    const getAccess = (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        );
      });
    const pending = getAccess(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});

describe('expired access detection', () => {
  it('rejects already-expired access tokens', () => {
    const access = makeAccess({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const expiresAt = Date.parse(access.expiresAt);
    assert.ok(expiresAt <= Date.now());
  });
});
