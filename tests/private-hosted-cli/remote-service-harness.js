'use strict';

const { createDefaultServices } = require('../../private/hosted-cli-candidate/default-services');
const {
  BASE_REVISION,
  DESCRIPTOR,
  finishedWatch,
  GRAPH,
  RUNTIME_CONFIG_PATH,
} = require('./candidate-fixtures');

function createTarget() {
  return {
    id: 'target-prod',
    url: 'https://target.example',
    organization: { id: 'org-1' },
    hostedSetup: {
      kind: 'zeroshot.private-hosted-setup/v3',
      repository: 'owner/repository',
      base: { kind: 'commit', revision: BASE_REVISION, targetBranch: 'main' },
      runtimeConfigPath: RUNTIME_CONFIG_PATH,
      configuredAt: '2026-08-03T00:00:00.000Z',
    },
  };
}

function createAdapter(options, calls) {
  return {
    access(capsuleId, signal) {
      const access = options.access?.(capsuleId, signal) ?? {
        accessToken: 'capsule-runtime-access',
      };
      calls.push(['access', capsuleId]);
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

function observationSnapshot(options) {
  return (
    options.observationSnapshot ?? {
      status: {
        phase: 'finished',
        observedGeneration: 3,
        currentRunId: 'run-3',
        atCursor: 'cursor-3',
      },
      atCursor: 'cursor-3',
    }
  );
}

function createObservationClient(calls, options) {
  return {
    get() {
      calls.push(['get']);
      return observationSnapshot(options);
    },
    stop(params) {
      calls.push(['stop', params]);
      return { effectiveMode: params.mode, runId: 'run-3' };
    },
  };
}

function createHostedSessionCoordinator(context) {
  return class HostedSessionCoordinator {
    constructor(init) {
      context.calls.push(['coordinator', init.capsuleId, init.targetAuthority]);
    }

    open() {
      context.calls.push(['initialize']);
      return { client: createObservationClient(context.calls, context.options) };
    }

    watch(options) {
      context.calls.push(['watch', options]);
      return (
        context.options.observationWatch?.(options) ??
        finishedWatch({
          runId: 'run-3',
          cursor: 'cursor-4',
          onCancel: () => context.calls.push(['watch-cancel']),
        })
      );
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

    clearMemory() {}
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
  const context = { calls, options };
  const runtime = createRuntime({ adapter, calls, context, options, state });
  const services = createDefaultServices({
    createCoordinator: options.createCoordinator,
    runtime,
    loadSettings: () => state,
    mutateSettings: (mutator) => mutator(state),
    httpTransport: () => ({ fetch: () => undefined }),
    createRunIntentClient: options.createRunIntentClient,
    followRunIntent: options.followRunIntent,
    observeRunIntent: options.observeRunIntent,
    runIntentSleep: options.runIntentSleep,
    randomUUID: () => `${String(++ids).padStart(8, '0')}-0000-4000-8000-000000000000`,
    environment: options.environment ?? {
      GH_TOKEN: 'github-test-token',
      LOCAL_MODEL_KEY: 'model-test-token',
    },
    githubFetch:
      options.githubFetch ??
      (() => new globalThis.Response(JSON.stringify({ sha: BASE_REVISION }), { status: 200 })),
    readHostedInputs: () => readHostedInputs(options, calls),
  });
  return { adapter, calls, services };
}

module.exports = { remoteHarness };
