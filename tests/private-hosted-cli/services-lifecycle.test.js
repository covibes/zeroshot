'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { RemoteDetachedError } = require('../../private/hosted-cli-candidate/orchestrator');
const {
  HostedSessionCoordinator: RealHostedSessionCoordinator,
} = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');
const { makeAccess, waitForRequest, waitForSocket } = require('../hosted-session/harness');
const { captureLogs, DESCRIPTOR } = require('./candidate-fixtures');
const { remoteHarness } = require('./remote-service-harness');

function registerCapsuleServiceTests() {
  it('creates, lists, and host-terminates capsules with distinct operations', async () => {
    const h = remoteHarness();
    await captureLogs(() =>
      h.services.capsuleCreate({ target: 'prod', label: 'candidate', size: 'small' })
    );
    await captureLogs(() => h.services.remoteList({ target: 'prod', limit: 7, json: true }));
    await captureLogs(() => h.services.capsuleTerminate('cap-1', { target: 'prod' }));

    const allocation = h.calls.find(([name]) => name === 'allocate')[1];
    assert.match(allocation.idempotencyKey, /^capsule_00000001/);
    assert.deepEqual(h.calls.find(([name]) => name === 'list')[1], { limit: 7 });
    assert.equal(h.calls.filter(([name]) => name === 'terminate').length, 1);
  });

  it('fails locally for unadvertised sizes and propagates known allocation refusals', async () => {
    const descriptor = {
      ...DESCRIPTOR,
      sizes: { catalog: ['tiny'], default: 'tiny' },
    };
    const local = remoteHarness({ descriptor });
    await assert.rejects(
      local.services.capsuleCreate({ target: 'prod', size: 'small' }),
      /not advertised/
    );
    assert.equal(
      local.calls.some(([name]) => name === 'allocate'),
      false
    );

    const refusal = Object.assign(new Error('Target access authorization failed'), {
      code: 'AUTH_FAILED',
    });
    const rejected = remoteHarness({ allocationError: refusal });
    await assert.rejects(
      rejected.services.capsuleCreate({ target: 'prod' }),
      (error) => error === refusal
    );
  });

  it('detaches through the service SIGINT boundary without host termination', async () => {
    const h = remoteHarness({ run: true, interruptWatch: true });
    const listenersBefore = process.listenerCount('SIGINT');
    await assert.rejects(
      captureLogs(() =>
        h.services.remoteRun({
          target: 'prod',
          graph: 'graph.json',
          input: 'input.json',
          detach: false,
        })
      ),
      (error) => {
        assert.ok(error instanceof RemoteDetachedError);
        assert.match(error.identities.allocationIdempotencyKey, /^allocate_/);
        assert.match(error.identities.applyIdempotencyKey, /^apply_/);
        return true;
      }
    );
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
    assert.equal(
      h.calls.some(([name]) => name === 'terminate'),
      false
    );
  });
}

function createReconnectFixture() {
  const sockets = [];
  const headers = [];
  let accessCount = 0;
  let deliveredBookmark;
  const bookmarkDelivered = new Promise((resolve) => {
    deliveredBookmark = resolve;
  });
  const webSocketFactory = (_url, _protocols, connectOptions) => {
    headers.push(connectOptions.headers.Authorization);
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  };
  const harness = remoteHarness({
    run: true,
    access: () =>
      makeAccess(`fresh-${++accessCount}`, {
        websocketUrl: 'wss://target.example/v1/capsules/cap-1/oecp',
      }),
    createCoordinator: (init) =>
      new RealHostedSessionCoordinator({
        ...init,
        connectOptions: { webSocketFactory },
      }),
    orchestratorOutput: {
      stdout(line) {
        if (line.includes('"cursor":"cursor-1"')) deliveredBookmark();
      },
      stderr() {},
    },
  });
  return { bookmarkDelivered, harness, headers, sockets };
}

async function initializeReconnectSocket(sockets, index, capabilities) {
  const socket = await waitForSocket(sockets, index);
  const request = await waitForRequest(socket, 'initialize');
  socket.respond(request.id, {
    protocolVersion: 'openengine.cluster/v1',
    capabilities,
    status: { phase: 'running' },
  });
  return socket;
}

async function proveReconnectUsesFreshAccess() {
  const { bookmarkDelivered, harness, headers, sockets } = createReconnectFixture();
  const running = captureLogs(() =>
    harness.services.remoteRun({
      target: 'prod',
      graph: 'graph.json',
      input: 'input.json',
      detach: false,
    })
  );
  const capabilities = { graphProfiles: ['openengine.graph.single-worker/v1'] };
  const initial = await initializeReconnectSocket(sockets, 0, capabilities);
  const plan = await waitForRequest(initial, 'plan');
  initial.respond(plan.id, { ok: true, diagnostics: [] });
  const apply = await waitForRequest(initial, 'apply');
  initial.respond(apply.id, {
    generation: 1,
    runId: 'run-1',
    phase: 'running',
    deduped: false,
  });

  const watched = await initializeReconnectSocket(sockets, 1, capabilities);
  const watch = await waitForRequest(watched, 'watch');
  watched.respond(watch.id, { subscriptionId: 'watch-1', runId: 'run-1' });
  watched.notify('event', {
    subscriptionId: 'watch-1',
    runId: 'run-1',
    cursor: 'cursor-1',
    event: { type: 'bookmark' },
  });
  await settle();
  await bookmarkDelivered;
  watched.readyState = 3;
  watched.emit('close', { code: 4401, reason: '' });

  const replacement = await initializeReconnectSocket(sockets, 2, capabilities);
  const resumed = await waitForRequest(replacement, 'watch');
  assert.deepEqual(resumed.params, { runId: 'run-1', fromCursor: 'cursor-1' });
  replacement.respond(resumed.id, { subscriptionId: 'watch-2', runId: 'run-1' });
  replacement.notify('event', {
    subscriptionId: 'watch-2',
    runId: 'run-1',
    cursor: 'cursor-2',
    event: {
      type: 'finished',
      final_status: {
        phase: 'finished',
        observedGeneration: 1,
        currentRunId: 'run-1',
        atCursor: 'cursor-2',
      },
    },
  });
  await settle();

  const finalSocket = await initializeReconnectSocket(sockets, 3, capabilities);
  const get = await waitForRequest(finalSocket, 'get');
  finalSocket.respond(get.id, {
    status: {
      phase: 'finished',
      observedGeneration: 1,
      currentRunId: 'run-1',
      atCursor: 'cursor-2',
    },
    atCursor: 'cursor-2',
  });
  const result = await running;
  assert.equal(result.value.final.status.atCursor, 'cursor-2');
  assert.deepEqual(headers, [
    'Bearer fresh-1',
    'Bearer fresh-2',
    'Bearer fresh-3',
    'Bearer fresh-4',
  ]);
}

function registerReconnectTest() {
  it(
    'uses fresh access and the delivered cursor after a real 4401 reconnect',
    proveReconnectUsesFreshAccess
  );
}

function registerRemoteOperationTests() {
  it('reports remote status and keeps drain/force stop separate from host termination', async () => {
    const h = remoteHarness();
    await captureLogs(() => h.services.remoteStatus('cap-1', { target: 'prod', json: true }));
    await captureLogs(() => h.services.remoteStop('cap-1', { target: 'prod', force: false }));
    await captureLogs(() => h.services.remoteStop('cap-1', { target: 'prod', force: true }));

    const stops = h.calls.filter(([name]) => name === 'stop').map(([, params]) => params);
    assert.deepEqual(
      stops.map(({ mode, ifGeneration }) => ({ mode, ifGeneration })),
      [
        { mode: 'drain', ifGeneration: 3 },
        { mode: 'force', ifGeneration: 3 },
      ]
    );
    assert.equal(
      h.calls.some(([name]) => name === 'terminate'),
      false
    );
  });

  it('wires explicit inputs through allocate, initialize, plan, apply, watch, and get', async () => {
    const h = remoteHarness({ run: true });
    const listenersBefore = process.listenerCount('SIGINT');
    const result = await captureLogs(() =>
      h.services.remoteRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        detach: false,
      })
    );
    assert.equal(result.value.final.status.phase, 'finished');
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
    assert.deepEqual(
      h.calls
        .filter(([name]) =>
          ['read-inputs', 'allocate', 'initialize', 'plan', 'apply', 'watch', 'get'].includes(name)
        )
        .map(([name]) => name),
      ['read-inputs', 'allocate', 'initialize', 'plan', 'apply', 'watch', 'initialize', 'get']
    );
    const request = h.calls.find(([name]) => name === 'apply')[1].input;
    assert.deepEqual(
      {
        repository: request.repository,
        provider: request.provider,
        modelLevel: request.modelLevel,
        providerProfile: request.providerProfile,
        isolationProfile: request.isolationProfile,
      },
      {
        repository: 'owner/repository',
        provider: 'codex',
        modelLevel: 'level2',
        providerProfile: 'provider.hosted-direct@1',
        isolationProfile: 'isolation.prepared-worktree@1',
      }
    );
  });
}

function registerCapsuleAndObservationServiceTests() {
  registerCapsuleServiceTests();
  registerReconnectTest();
  registerRemoteOperationTests();
}

describe('private capsule and observation services', registerCapsuleAndObservationServiceTests);
