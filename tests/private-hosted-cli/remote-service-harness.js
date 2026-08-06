'use strict';

const { createDefaultServices } = require('../../private/hosted-cli-candidate/default-services');
const { DESCRIPTOR, finishedWatch, GRAPH, RUNTIME_DIGEST } = require('./candidate-fixtures');

function createTarget() {
  return {
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
}

function createAdapter(options, calls) {
  return {
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
}

function createRunClient(calls) {
  return {
    plan(params) {
      calls.push(['plan', params]);
      return { ok: true, diagnostics: [] };
    },
    apply(params) {
      calls.push(['apply', params]);
      return { generation: 1, runId: 'run-1' };
    },
  };
}

function createFinishedClient(calls, status) {
  return {
    get() {
      calls.push(['get']);
      return { status };
    },
  };
}

function createObservationClient(calls) {
  return {
    ...createFinishedClient(calls, {
      phase: 'finished',
      observedGeneration: 3,
      currentRunId: 'run-3',
      atCursor: 'cursor-3',
    }),
    stop(params) {
      calls.push(['stop', params]);
      return { effectiveMode: params.mode, runId: 'run-3' };
    },
  };
}

function openHostedSession(context) {
  const { calls, options } = context;
  calls.push(['initialize']);
  context.runOpenCount += 1;
  if (options.run) {
    return {
      initializeResult: {
        capabilities: { graphProfiles: ['openengine.graph.single-worker/v1'] },
      },
      client:
        context.runOpenCount === 1
          ? createRunClient(calls)
          : createFinishedClient(calls, {
              phase: 'finished',
              observedGeneration: 1,
              currentRunId: 'run-1',
              atCursor: 'cursor-1',
            }),
    };
  }
  return { client: createObservationClient(calls) };
}

function interruptedWatch(calls, params) {
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

function createHostedSessionCoordinator(context) {
  return class HostedSessionCoordinator {
    constructor(init) {
      context.calls.push(['coordinator', init.capsuleId, init.targetAuthority]);
    }

    open() {
      return openHostedSession(context);
    }

    watch(params) {
      const { calls, options } = context;
      calls.push(['watch', params]);
      if (options.interruptWatch) return interruptedWatch(calls, params);
      return finishedWatch({
        runId: 'run-1',
        cursor: 'cursor-1',
        onCancel: () => calls.push(['watch-cancel']),
      });
    }

    close() {
      context.calls.push(['close']);
    }
  };
}

function createTargetSessionManager() {
  return class TargetSessionManager {
    tokenProvider() {
      return () => Promise.resolve('access-token');
    }
  };
}

function createRuntime({ adapter, calls, context, options, state }) {
  return {
    cluster: { assertGraphSpec: () => undefined },
    hostedSession: {
      HostedSessionCoordinator: createHostedSessionCoordinator(context),
    },
    hostedTarget: {
      createTargetAdapter(init) {
        calls.push(['adapter', init.organization.id]);
        return adapter;
      },
    },
    target: {
      TargetSessionManager: createTargetSessionManager(),
      discoverTargetSessionEndpoints() {
        calls.push(['discover']);
        return { descriptor: options.descriptor ?? DESCRIPTOR };
      },
      getTarget: (name) => state._targets[name],
      KeyringCredentialStore: { create: () => ({}) },
    },
  };
}

function createManifest() {
  return {
    privateMarker: 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH',
    repository: 'owner/repository',
    provider: 'codex',
    modelLevel: 'level2',
    runtimeImageDigest: RUNTIME_DIGEST,
  };
}

function readHostedInputs(options, calls) {
  calls.push(['read-inputs']);
  return {
    graph: GRAPH,
    input: options.hostedInput ?? {
      source: 'prompt',
      prompt: 'Ship the change.',
      artifacts: [],
    },
  };
}

function remoteHarness(options = {}) {
  const calls = [];
  let ids = 0;
  const state = { _targets: { prod: createTarget() } };
  const adapter = createAdapter(options, calls);
  const context = { calls, options, runOpenCount: 0 };
  const runtime = createRuntime({ adapter, calls, context, options, state });
  const services = createDefaultServices({
    createCoordinator: options.createCoordinator,
    orchestratorOutput: options.orchestratorOutput,
    runtime,
    loadSettings: () => state,
    mutateSettings: (mutator) => mutator(state),
    httpTransport: () => ({ fetch: () => undefined }),
    createRunIntentClient: options.createRunIntentClient,
    followRunIntent: options.followRunIntent,
    runIntentSleep: options.runIntentSleep,
    randomUUID: () => `${String(++ids).padStart(8, '0')}-0000-0000-0000-000000000000`,
    manifest: createManifest(),
    readHostedInputs: () => readHostedInputs(options, calls),
  });
  return { adapter, calls, services };
}

module.exports = { remoteHarness };
