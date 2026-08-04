'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createDefaultServices } = require('../../private/hosted-cli-candidate/default-services');
const { RemoteDetachedError } = require('../../private/hosted-cli-candidate/orchestrator');
const { createTargetServices } = require('../../private/hosted-cli-candidate/target-services');
const {
  HostedSessionCoordinator: RealHostedSessionCoordinator,
} = require('../../lib/hosted-session/index.cjs');
const { FakeWebSocket, settle } = require('../cluster/harness');
const { makeAccess, waitForRequest, waitForSocket } = require('../hosted-session/harness');

const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const GRAPH = {
  profile: 'openengine.graph.single-worker/v1',
  root: { kind: 'step', worker: 'legacy.zeroshot.ship@1', attempts: 1 },
};
const DESCRIPTOR = {
  origin: 'https://target.example',
  oauth: {
    deviceAuthorizationEndpoint: 'https://target.example/oauth/device',
    tokenEndpoint: 'https://target.example/oauth/token',
    revocationEndpoint: 'https://target.example/oauth/revoke',
    clientId: 'private-candidate',
    deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
    audience: 'capsule',
  },
  capsule: { baseUrl: 'https://target.example/capsules/' },
  session: { routeTemplate: { template: '/sessions/{capsuleId}' } },
  sizes: { catalog: ['tiny', 'small', 'standard', 'large'], default: 'small' },
};

async function captureLogs(operation) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  try {
    const value = await operation();
    return { lines, value };
  } finally {
    console.log = original;
  }
}

function targetHarness() {
  const calls = [];
  const state = {
    _targets: {
      prod: {
        id: 'target-prod',
        url: 'https://target.example',
        organization: { id: 'org-1' },
        createdAt: '2026-08-03T00:00:00.000Z',
      },
    },
  };
  class TargetSessionManager {
    constructor(options) {
      calls.push(['session', options.targetName]);
    }

    login() {
      calls.push(['login']);
      return { organization: { id: 'org-1' } };
    }

    revoke(force) {
      calls.push(['revoke', force]);
    }
  }
  const runtime = {
    target: {
      TARGET_ACCOUNT: 'refresh-token',
      TargetSessionManager,
      acquireTargetLock: () => undefined,
      addTarget(name, url, settings, descriptor) {
        calls.push(['add', name, url, descriptor.origin]);
        const record = {
          id: `target-${name}`,
          url,
          createdAt: '2026-08-04T00:00:00.000Z',
        };
        settings.mutate((current) => {
          current._targets[name] = record;
        });
        return record;
      },
      discoverTarget(url) {
        calls.push(['discover', url]);
        return DESCRIPTOR;
      },
      KeyringCredentialStore: {
        create() {
          return {
            delete(service, account) {
              calls.push(['delete', service, account]);
            },
          };
        },
      },
      listTargets(settings) {
        return Object.entries(settings.load()._targets).map(([name, record]) => ({ name, record }));
      },
      normalizeAndValidateUrl: (url) => url,
      removeTarget(name, settings) {
        calls.push(['remove', name]);
        settings.mutate((current) => {
          delete current._targets[name];
        });
      },
      targetServiceKey: (id) => `zeroshot-target-${id}`,
    },
  };
  const settings = {
    load: () => state,
    mutate: (mutator) => mutator(state),
  };
  const services = createTargetServices({
    runtime,
    settings,
    httpTransport: () => ({ fetch: () => undefined }),
    requireTarget: (name) => state._targets[name],
  });
  return { calls, services, state };
}

function remoteHarness(options = {}) {
  const calls = [];
  let ids = 0;
  const target = {
    id: 'target-prod',
    url: 'https://target.example',
    organization: { id: 'org-1' },
    hostedSetup: {
      kind: 'zeroshot.private-hosted-setup/v1',
      repository: 'owner/repository',
      provider: 'codex',
      modelLevel: 'level2',
      configuredAt: '2026-08-03T00:00:00.000Z',
    },
  };
  const state = { _targets: { prod: target } };
  const adapter = {
    access(capsuleId, signal) {
      const access = options.access?.(capsuleId, signal);
      if (!access) throw new Error('unexpected capsule access request');
      calls.push(['access', access.accessToken]);
      return access;
    },
    allocate(params) {
      calls.push(['allocate', params]);
      if (options.allocationError) throw options.allocationError;
      return {
        id: 'cap-1',
        state: 'ready',
        label: params.label ?? null,
        createdAt: '2026-08-04T00:00:00.000Z',
      };
    },
    inspect(id) {
      calls.push(['inspect', id]);
      return { id, state: 'ready' };
    },
    list(params) {
      calls.push(['list', params]);
      return {
        capsules: [
          {
            id: 'cap-1',
            state: 'ready',
            label: null,
            createdAt: '2026-08-04T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      };
    },
    terminate(id) {
      calls.push(['terminate', id]);
      return { id, state: 'terminating' };
    },
  };
  let runOpenCount = 0;
  class HostedSessionCoordinator {
    constructor(init) {
      calls.push(['coordinator', init.capsuleId, init.targetAuthority]);
    }

    open() {
      calls.push(['initialize']);
      runOpenCount += 1;
      if (options.run) {
        return {
          initializeResult: {
            capabilities: { graphProfiles: ['openengine.graph.single-worker/v1'] },
          },
          client:
            runOpenCount === 1
              ? {
                  plan(params) {
                    calls.push(['plan', params]);
                    return { ok: true, diagnostics: [] };
                  },
                  apply(params) {
                    calls.push(['apply', params]);
                    return { generation: 1, runId: 'run-1' };
                  },
                }
              : {
                  get() {
                    calls.push(['get']);
                    return {
                      status: {
                        phase: 'finished',
                        observedGeneration: 1,
                        currentRunId: 'run-1',
                        atCursor: 'cursor-1',
                      },
                    };
                  },
                },
        };
      }
      return {
        client: {
          get() {
            calls.push(['get']);
            return {
              status: {
                phase: 'finished',
                observedGeneration: 3,
                currentRunId: 'run-3',
                atCursor: 'cursor-3',
              },
            };
          },
          stop(params) {
            calls.push(['stop', params]);
            return { effectiveMode: params.mode, runId: 'run-3' };
          },
        },
      };
    }

    watch(params) {
      calls.push(['watch', params]);
      if (options.interruptWatch) {
        process.emit('SIGINT');
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            return Promise.reject(params.signal.reason);
          },
          cancel() {
            calls.push(['watch-cancel']);
          },
        };
      }
      let delivered = false;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (delivered) return { done: true };
          delivered = true;
          return {
            done: false,
            value: {
              type: 'event',
              runId: 'run-1',
              cursor: 'cursor-1',
              event: {
                type: 'finished',
                final_status: {
                  phase: 'finished',
                  observedGeneration: 1,
                  currentRunId: 'run-1',
                  atCursor: 'cursor-1',
                },
              },
            },
          };
        },
        cancel() {
          calls.push(['watch-cancel']);
        },
      };
    }

    close() {
      calls.push(['close']);
    }
  }
  class TargetSessionManager {
    tokenProvider() {
      return () => Promise.resolve('access-token');
    }
  }
  const runtime = {
    cluster: { assertGraphSpec: () => undefined },
    hostedSession: { HostedSessionCoordinator },
    hostedTarget: {
      createTargetAdapter(init) {
        calls.push(['adapter', init.organization.id]);
        return adapter;
      },
    },
    target: {
      TargetSessionManager,
      discoverTarget() {
        calls.push(['discover']);
        return options.descriptor ?? DESCRIPTOR;
      },
      getTarget: (name) => state._targets[name],
      KeyringCredentialStore: { create: () => ({}) },
    },
  };
  const services = createDefaultServices({
    createCoordinator: options.createCoordinator,
    orchestratorOutput: options.orchestratorOutput,
    runtime,
    loadSettings: () => state,
    mutateSettings: (mutator) => mutator(state),
    httpTransport: () => ({ fetch: () => undefined }),
    randomUUID: () => `${String(++ids).padStart(8, '0')}-0000-0000-0000-000000000000`,
    manifest: {
      privateMarker: 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH',
      repository: 'owner/repository',
      provider: 'codex',
      modelLevel: 'level2',
      runtimeImageDigest: RUNTIME_DIGEST,
    },
    readHostedInputs: () => {
      calls.push(['read-inputs']);
      return {
        graph: GRAPH,
        input: { source: 'prompt', prompt: 'Ship the change.', artifacts: [] },
      };
    },
  });
  return { adapter, calls, services };
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
});
