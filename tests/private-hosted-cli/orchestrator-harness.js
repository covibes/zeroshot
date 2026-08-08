'use strict';

const { HostedRunOrchestrator } = require('../../private/hosted-cli-candidate/orchestrator');
const { finishedWatch, GRAPH, RUNTIME_BUNDLE, RUNTIME_DIGEST } = require('./candidate-fixtures');

const CALLER_INPUT = Object.freeze({
  source: 'prompt',
  prompt: 'Ship the requested change.',
  artifacts: [],
});

function createCoordinatorHarness(sequence, requests, overrides) {
  const initialClient = {
    plan(params) {
      sequence.push('plan');
      requests.plan.push(params);
      return { ok: true, diagnostics: [] };
    },
    apply(params) {
      sequence.push('apply');
      requests.apply.push(params);
      return { generation: 1, runId: 'server-run-1', phase: 'running', deduped: false };
    },
    ...overrides.initialClient,
  };
  const finalClient = {
    get() {
      sequence.push('get');
      return {
        status: {
          phase: 'finished',
          observedGeneration: 1,
          currentRunId: 'server-run-1',
          atCursor: 'cursor-2',
        },
      };
    },
    ...overrides.finalClient,
  };
  let opens = 0;
  const coordinator = {
    open() {
      sequence.push('initialize');
      opens += 1;
      return {
        initializeResult: {
          capabilities: { graphProfiles: ['openengine.graph.single-worker/v1'] },
        },
        client: opens === 1 ? initialClient : finalClient,
      };
    },
    watch() {
      sequence.push('watch');
      return finishedWatch({
        runId: 'server-run-1',
        cursor: 'cursor-2',
        onCancel: () => sequence.push('watch-cancel'),
      });
    },
    close() {
      sequence.push('close');
    },
    ...overrides.coordinator,
  };
  return coordinator;
}

function base(overrides = {}) {
  const sequence = [];
  const requests = { plan: [], apply: [], runtime: undefined };
  let ids = 0;
  const adapter = {
    credentialInstall: { supported: true },
    allocate() {
      sequence.push('allocate');
      return { id: 'cap1', state: 'ready' };
    },
    inspect() {
      sequence.push('inspect');
      return { id: 'cap1', state: 'ready' };
    },
    terminate() {
      sequence.push('terminate');
      return { id: 'cap1', state: 'terminating' };
    },
    access() {
      sequence.push('access');
      return { accessToken: 'capsule-access' };
    },
    installRuntime(_capsuleId, runtime, accessToken) {
      sequence.push('install-runtime');
      requests.runtime = { runtime, accessToken };
    },
    ...overrides.adapter,
  };
  const coordinator = createCoordinatorHarness(sequence, requests, overrides);
  const output = { stdout: [], stderr: [] };
  const orchestrator = new HostedRunOrchestrator({
    assertGraphSpec: () => undefined,
    readInputs: () => {
      sequence.push('read-inputs');
      return { graph: GRAPH, input: overrides.input ?? CALLER_INPUT };
    },
    resolveRuntimeBundle: () => {
      sequence.push('resolve-runtime');
      return RUNTIME_BUNDLE;
    },
    createCoordinator: () => coordinator,
    randomUUID: () => `${String(++ids).padStart(8, '0')}-0000-0000-0000-000000000000`,
    runtimeImageDigest: RUNTIME_DIGEST,
    sleep: () => undefined,
    output: {
      stdout: (line) => output.stdout.push(line),
      stderr: (line) => output.stderr.push(line),
    },
  });
  return {
    adapter,
    coordinator,
    orchestrator,
    output,
    requests,
    sequence,
    options: {
      adapter,
      target: { id: 'target1', url: 'https://target.example', organization: { id: 'org1' } },
      graphPath: 'graph.json',
      inputPath: 'input.json',
      detach: false,
    },
  };
}

module.exports = { base, CALLER_INPUT };
