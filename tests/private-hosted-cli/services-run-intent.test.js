'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { captureLogs, DESCRIPTOR } = require('./candidate-fixtures');
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

function registerQueueSubmissionTests() {
  it('submits one resolved runtime beside a credential-free v2 RunIntent', async () => {
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
    assert.equal(submitted.runtime.runtime.provider, 'claude');
    assert.equal(submitted.runtime.runtime.environment.ANTHROPIC_API_KEY, 'model-test-token');
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
}

function registerQueueObservationTests() {
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
}

function registerRunIntentManagementTests() {
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
}

function registerRunIntentServiceTests() {
  registerQueueSubmissionTests();
  registerQueueObservationTests();
  registerRunIntentManagementTests();
}

describe('private RunIntent services', registerRunIntentServiceTests);
