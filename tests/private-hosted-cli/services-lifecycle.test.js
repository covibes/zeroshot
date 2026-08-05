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
const { targetHarness } = require('./target-service-harness');

const INTENT_ID = '019fd184-52c3-7e1f-a567-4ecb6fc6a0ec';
const INTENT_CAPSULE_ID = '019fd184-58d2-7db4-a878-5bd495c986a4';
const SUBMISSION_KEY = '019fd184-637d-4f26-af31-5ec3b3ef1dd6';
const NOW = '2026-08-05T10:00:00.000Z';

function intent(overrides = {}) {
  return {
    intent_id: INTENT_ID,
    state: 'queued',
    waiting_reason: null,
    capsule_id: null,
    result: null,
    error_code: null,
    submitted_at: NOW,
    updated_at: NOW,
    terminal_at: null,
    ...overrides,
  };
}

describe('private target services', () => {
  it('runs add, login, list, setup, and remove through production service wiring', async () => {
    const h = targetHarness();
    await captureLogs(() => h.services.targetAdd('next', { url: 'https://target.example' }));
    await captureLogs(() => h.services.targetLogin('prod'));
    await captureLogs(() =>
      h.services.targetSetup('prod', {
        repository: 'owner/repository',
        provider: 'codex',
        modelLevel: 'level2',
      })
    );
    const listed = await captureLogs(() => h.services.targetList({ json: true }));
    assert.match(listed.lines[0], /"configured": true/);
    await captureLogs(() => h.services.targetRemove('prod', { force: false }));

    assert.deepEqual(h.state._targets.prod, undefined);
    assert.equal(h.state._targets.next.id, 'target-next');
    assert.equal(h.calls.filter(([name]) => name === 'login').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'revoke').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'delete').length, 1);
  });
});

describe('private capsule and observation services', () => {
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

  it('uses fresh access and the delivered cursor after a real 4401 reconnect', async () => {
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
    const h = remoteHarness({
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
    const running = captureLogs(() =>
      h.services.remoteRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        detach: false,
      })
    );
    const capabilities = { graphProfiles: ['openengine.graph.single-worker/v1'] };
    const initialize = async (index) => {
      const socket = await waitForSocket(sockets, index);
      const request = await waitForRequest(socket, 'initialize');
      socket.respond(request.id, {
        protocolVersion: 'openengine.cluster/v1',
        capabilities,
        status: { phase: 'running' },
      });
      return socket;
    };

    const initial = await initialize(0);
    const plan = await waitForRequest(initial, 'plan');
    initial.respond(plan.id, { ok: true, diagnostics: [] });
    const apply = await waitForRequest(initial, 'apply');
    initial.respond(apply.id, {
      generation: 1,
      runId: 'run-1',
      phase: 'running',
      deduped: false,
    });

    const watched = await initialize(1);
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

    const replacement = await initialize(2);
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

    const finalSocket = await initialize(3);
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
  });

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

  it('submits and follows a credential-free v2 RunIntent through one client', async () => {
    const queueCalls = [];
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit(request) {
          queueCalls.push(['submit', request]);
          return intent();
        },
        get(id) {
          queueCalls.push(['get', id]);
          return intent({
            state: 'succeeded',
            capsule_id: INTENT_CAPSULE_ID,
            result: { summary: 'done' },
            terminal_at: NOW,
          });
        },
      }),
      runIntentSleep: () => Promise.resolve(),
    });
    const result = await captureLogs(() =>
      h.services.remoteQueueRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        queue: true,
        submissionKey: SUBMISSION_KEY,
        detach: false,
      })
    );
    assert.equal(result.value.state, 'succeeded');
    assert.deepEqual(
      queueCalls.map(([name]) => name),
      ['submit', 'get']
    );
    const submitted = queueCalls[0][1];
    assert.equal(submitted.submissionKey, SUBMISSION_KEY);
    assert.deepEqual(Object.keys(submitted.envelope), ['version', 'graph', 'input']);
    assert.equal(submitted.envelope.version, 'zeroshot.run-intent/v2');
    assert.deepEqual(submitted.envelope.input, {
      source: 'prompt',
      prompt: 'Ship the change.',
      artifacts: [],
    });
  });

  it('fails closed when the target does not advertise RunIntent v2', async () => {
    const h = remoteHarness({
      descriptor: { ...DESCRIPTOR, runIntent: null },
    });
    await assert.rejects(
      h.services.remoteQueueRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        queue: true,
        submissionKey: SUBMISSION_KEY,
        detach: true,
      }),
      /does not advertise RunIntent v2/
    );
  });

  it('keeps Ctrl+C as queue observation disconnect without cancellation', async () => {
    const queueCalls = [];
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit() {
          queueCalls.push(['submit']);
          return intent();
        },
        get(_id, options) {
          queueCalls.push(['get']);
          process.emit('SIGINT');
          return Promise.reject(options.signal.reason);
        },
        cancel() {
          queueCalls.push(['cancel']);
        },
      }),
      runIntentSleep: () => Promise.resolve(),
    });
    const listenersBefore = process.listenerCount('SIGINT');
    const result = await captureLogs(() =>
      h.services.remoteQueueRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        queue: true,
        submissionKey: SUBMISSION_KEY,
        detach: false,
      })
    );
    assert.equal(result.value.state, 'queued');
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
    assert.equal(
      queueCalls.some(([name]) => name === 'cancel'),
      false
    );
    assert.match(result.lines.join('\n'), /was not cancelled/);
  });

  it('preserves exact-key recovery guidance after an ambiguous submission', async () => {
    let submissions = 0;
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit() {
          submissions += 1;
          throw new Error('peer-secret-detail');
        },
      }),
    });
    await assert.rejects(
      captureLogs(() =>
        h.services.remoteQueueRun({
          target: 'prod',
          graph: 'graph.json',
          input: 'input.json',
          queue: true,
          submissionKey: SUBMISSION_KEY,
          detach: true,
        })
      ),
      (error) => {
        assert.match(error.message, new RegExp(`--submission-key ${SUBMISSION_KEY}`));
        assert.doesNotMatch(error.message, /peer-secret-detail/);
        return true;
      }
    );
    assert.equal(submissions, 1);
  });

  it('reads status, follows, and cancels only through explicit RunIntent operations', async () => {
    const queueCalls = [];
    const h = remoteHarness({
      createRunIntentClient: () => ({
        get(id) {
          queueCalls.push(['get', id]);
          return intent({
            state: 'succeeded',
            capsule_id: INTENT_CAPSULE_ID,
            result: { summary: 'done' },
            terminal_at: NOW,
          });
        },
        cancel(id) {
          queueCalls.push(['cancel', id]);
          return intent({ state: 'cancelling', capsule_id: INTENT_CAPSULE_ID });
        },
      }),
    });
    await captureLogs(() =>
      h.services.runIntentStatus('prod', INTENT_ID, { follow: true, json: false })
    );
    await captureLogs(() => h.services.runIntentCancel('prod', INTENT_ID));
    assert.deepEqual(queueCalls, [
      ['get', INTENT_ID],
      ['cancel', INTENT_ID],
    ]);
  });

  it('reports a purged successful result without inventing an empty object', async () => {
    const h = remoteHarness({
      createRunIntentClient: () => ({
        get() {
          return intent({
            state: 'succeeded',
            capsule_id: INTENT_CAPSULE_ID,
            result: null,
            terminal_at: NOW,
          });
        },
      }),
    });
    const result = await captureLogs(() =>
      h.services.runIntentStatus('prod', INTENT_ID, { follow: true, json: false })
    );
    assert.equal(result.value.result, null);
    assert.match(result.lines.join('\n'), /result is no longer retained/);
    assert.doesNotMatch(result.lines.join('\n'), /^\{\}$/m);
  });
});
