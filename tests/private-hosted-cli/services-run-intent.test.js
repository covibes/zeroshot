'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { captureLogs, DESCRIPTOR, detachedRunOptions } = require('./candidate-fixtures');
const { remoteHarness } = require('./remote-service-harness');

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

function succeeded() {
  return intent({
    state: 'succeeded',
    capsule_id: INTENT_CAPSULE_ID,
    result: { summary: 'done' },
    terminal_at: NOW,
  });
}

function stateClient(states, runCalls, additional = {}) {
  return {
    ...additional,
    get(id) {
      runCalls.push(['get', id]);
      return states.shift();
    },
  };
}

function registerSubmissionTests() {
  it('submits one runtime beside a credential-free v2 RunIntent and follows by default', async () => {
    const runCalls = [];
    const states = [intent({ state: 'running', capsule_id: INTENT_CAPSULE_ID }), succeeded()];
    const h = remoteHarness({
      createRunIntentClient: () =>
        stateClient(states, runCalls, {
          submit(request) {
            runCalls.push(['submit', request]);
            return intent();
          },
        }),
      runIntentSleep: () => Promise.resolve(),
    });
    const result = await captureLogs(() =>
      h.services.remoteRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        submissionKey: SUBMISSION_KEY,
        detach: false,
        size: 'tiny',
        ship: true,
      })
    );
    assert.equal(result.value.state, 'succeeded');
    assert.deepEqual(
      runCalls.map(([name]) => name),
      ['submit', 'get', 'get']
    );
    const submitted = runCalls[0][1];
    assert.equal(submitted.submissionKey, SUBMISSION_KEY);
    assert.equal(submitted.size, 'tiny');
    assert.deepEqual(Object.keys(submitted.envelope), ['version', 'graph', 'input']);
    assert.equal(submitted.envelope.version, 'zeroshot.run-intent/v2');
    assert.equal(submitted.runtime.runtime.provider, 'claude');
    assert.equal(submitted.runtime.delivery.mode, 'ship');
    assert.equal(submitted.runtime.runtime.environment.ANTHROPIC_API_KEY, 'model-test-token');
    assert.deepEqual(submitted.envelope.input, {
      source: 'prompt',
      prompt: 'Ship the change.',
      artifacts: [],
    });
    assert.equal(
      h.calls.some(([name]) => name === 'allocate'),
      false
    );
    assert.equal(
      h.calls.some(([name]) => name === 'coordinator'),
      true
    );
  });

  it('fails closed when the target does not advertise RunIntent v2', async () => {
    const h = remoteHarness({ descriptor: { ...DESCRIPTOR, runIntent: null } });
    await assert.rejects(
      h.services.remoteRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        submissionKey: SUBMISSION_KEY,
        detach: true,
      }),
      /does not advertise RunIntent v2/
    );
  });

  it('omits size to preserve the target-advertised default', async () => {
    let submitted;
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit(request) {
          submitted = request;
          return intent();
        },
      }),
    });
    await captureLogs(() => h.services.remoteRun(detachedRunOptions(SUBMISSION_KEY)));
    assert.equal(Object.hasOwn(submitted, 'size'), false);
  });
}

function registerObservationTests() {
  it('keeps Ctrl+C as a detach without cancellation', async () => {
    const runCalls = [];
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit() {
          runCalls.push(['submit']);
          return intent();
        },
        get(_id, options) {
          runCalls.push(['get']);
          process.emit('SIGINT');
          return Promise.reject(options.signal.reason);
        },
        cancel() {
          runCalls.push(['cancel']);
        },
      }),
      runIntentSleep: () => Promise.resolve(),
    });
    const listenersBefore = process.listenerCount('SIGINT');
    const result = await captureLogs(() =>
      h.services.remoteRun({
        target: 'prod',
        graph: 'graph.json',
        input: 'input.json',
        submissionKey: SUBMISSION_KEY,
        detach: false,
      })
    );
    assert.equal(result.value.state, 'queued');
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
    assert.equal(
      runCalls.some(([name]) => name === 'cancel'),
      false
    );
    assert.match(result.lines.join('\n'), /was not cancelled/);
  });

  it('preserves exact-key recovery guidance after an ambiguous submission', async () => {
    const h = remoteHarness({
      createRunIntentClient: () => ({
        submit() {
          throw new Error('peer-secret-detail');
        },
      }),
    });
    await assert.rejects(
      captureLogs(() => h.services.remoteRun(detachedRunOptions(SUBMISSION_KEY))),
      (error) => {
        assert.match(error.message, new RegExp(`--submission-key ${SUBMISSION_KEY}`));
        assert.doesNotMatch(error.message, /peer-secret-detail/);
        return true;
      }
    );
  });

  it('attaches by RunIntent ID using capsule get and cursor watch', async () => {
    const runCalls = [];
    const states = [intent({ state: 'running', capsule_id: INTENT_CAPSULE_ID }), succeeded()];
    const h = remoteHarness({
      observationSnapshot: {
        status: {
          phase: 'running',
          observedGeneration: 1,
          currentRunId: 'run-1',
          atCursor: 'cursor-8',
        },
        atCursor: 'cursor-8',
      },
      createRunIntentClient: () => stateClient(states, runCalls),
      runIntentSleep: () => Promise.resolve(),
    });
    const result = await captureLogs(() => h.services.remoteAttach('prod', INTENT_ID));
    assert.equal(result.value.state, 'succeeded');
    const watch = h.calls.find(([name]) => name === 'watch');
    assert.deepEqual(watch[1].params, { runId: 'run-1', fromCursor: 'cursor-8' });
    assert.equal(
      h.calls.some(([name]) => name === 'watch-cancel'),
      true
    );
    assert.deepEqual(runCalls, [
      ['get', INTENT_ID],
      ['get', INTENT_ID],
    ]);
    assert.doesNotMatch(result.lines.join('\n'), /agent.output|agent_output/);
  });
}

function registerManagementTests() {
  it('reads status and cancels only through explicit RunIntent operations', async () => {
    const runCalls = [];
    const h = remoteHarness({
      createRunIntentClient: () => ({
        get(id) {
          runCalls.push(['get', id]);
          return succeeded();
        },
        cancel(id) {
          runCalls.push(['cancel', id]);
          return intent({ state: 'cancelling', capsule_id: INTENT_CAPSULE_ID });
        },
      }),
    });
    await captureLogs(() => h.services.runIntentStatus('prod', INTENT_ID, { json: false }));
    await captureLogs(() => h.services.runIntentCancel('prod', INTENT_ID));
    assert.deepEqual(runCalls, [
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
    const result = await captureLogs(() => h.services.remoteAttach('prod', INTENT_ID));
    assert.equal(result.value.result, null);
    assert.match(result.lines.join('\n'), /result is no longer retained/);
    assert.doesNotMatch(result.lines.join('\n'), /^\{\}$/m);
  });
}

describe('private RunIntent services', () => {
  registerSubmissionTests();
  registerObservationTests();
  registerManagementTests();
});
