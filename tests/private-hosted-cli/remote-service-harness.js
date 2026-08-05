'use strict';

const { createDefaultServices } = require('../../private/hosted-cli-candidate/default-services');
const { DESCRIPTOR, finishedWatch, GRAPH, RUNTIME_DIGEST } = require('./candidate-fixtures');

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
      return finishedWatch({
        runId: 'run-1',
        cursor: 'cursor-1',
        onCancel: () => calls.push(['watch-cancel']),
      });
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
    createRunIntentClient: options.createRunIntentClient,
    followRunIntent: options.followRunIntent,
    runIntentSleep: options.runIntentSleep,
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
        input: options.hostedInput ?? {
          source: 'prompt',
          prompt: 'Ship the change.',
          artifacts: [],
        },
      };
    },
  });
  return { adapter, calls, services };
}

module.exports = { remoteHarness };
