const path = require('node:path');

const { runOmpRpcTask } = require('../../lib/agent-cli-provider/omp/rpc-driver');
const {
  MAX_PENDING_REQUESTS,
  MAX_LIFETIME_REQUEST_IDS,
  MAX_NORMALIZED_OUTPUT_BYTES,
  MAX_STDERR_TAIL_BYTES,
} = require('../../lib/agent-cli-provider/omp/rpc-bounds');

const FAKE_OMP_RPC_PATH = path.join(__dirname, 'fake-omp-rpc.js');

function fakeCommandSpec(overrides = {}) {
  return {
    binary: process.execPath,
    args: [FAKE_OMP_RPC_PATH],
    env: {},
    cleanupMetadata: [],
    warnings: [],
    redactions: [],
    ...overrides,
  };
}

function withScenario(scenario, fn) {
  const previous = process.env.OMP_FAKE_RPC_SCENARIO;
  process.env.OMP_FAKE_RPC_SCENARIO = scenario;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.OMP_FAKE_RPC_SCENARIO;
      else process.env.OMP_FAKE_RPC_SCENARIO = previous;
    });
}

function runTask(overrides = {}) {
  const controller = new AbortController();
  const events = [];
  const sessions = [];
  const spawns = [];
  return runOmpRpcTask(
    {
      commandSpec: fakeCommandSpec(),
      prompt: 'do the thing',
      expectedVersion: '17.2.1',
      session: { kind: 'none' },
      signal: controller.signal,
      timeoutMs: 5000,
      abortGraceMs: 200,
      exitGraceMs: 200,
      ...overrides,
    },
    {
      onSpawn: (evidence) => {
        spawns.push(evidence);
        return Promise.resolve();
      },
      onEvent: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      onSession: (evidence) => {
        sessions.push(evidence);
        return Promise.resolve();
      },
    }
  ).then((result) => ({ result, events, sessions, spawns, controller }));
}

module.exports = {
  MAX_LIFETIME_REQUEST_IDS,
  MAX_NORMALIZED_OUTPUT_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_STDERR_TAIL_BYTES,
  fakeCommandSpec,
  runOmpRpcTask,
  runTask,
  withScenario,
};
