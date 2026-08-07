'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MAX_RUN_INTENT_BYTES,
  MAX_RUN_INTENT_DISPATCH_BYTES,
  MAX_RUN_INTENT_REQUEST_BYTES,
  MAX_RUN_INTENT_RESPONSE_BYTES,
  MAX_RUNTIME_BUNDLE_BYTES,
  RUN_INTENT_VERSION,
  RunIntentClient,
  RunIntentHttpError,
  buildRunIntentEnvelope,
  followRunIntent,
  validateRunIntent,
} = require('../../private/hosted-cli-candidate/run-intent');
const {
  DESCRIPTOR,
  GRAPH,
  RUNTIME_BUNDLE,
  runIntent,
  RUN_INTENT_ID: INTENT_ID,
  RUN_INTENT_NOW: NOW,
} = require('./candidate-fixtures');

const ORGANIZATION_ID = '019fd17e-5e50-7c66-a68c-3fcf4d8f06c0';
const SUBMISSION_KEY = '019fd17e-8406-41b4-8730-1c54fd44c70e';
const CAPSULE_ID = '019fd17e-b9c4-7ef1-99da-cc0ef3905402';
const OTHER_INTENT_ID = '019fd184-52c3-7e1f-a567-4ecb6fc6a0ec';

function jsonResponse(value, status = 200) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientHarness(responses) {
  const requests = [];
  const tokens = [];
  let refreshes = 0;
  const client = new RunIntentClient({
    descriptor: DESCRIPTOR.runIntent,
    organizationId: ORGANIZATION_ID,
    tokenProvider: {
      getAccessToken() {
        const token = refreshes === 0 ? 'access-before-refresh' : 'access-after-refresh';
        tokens.push(token);
        return Promise.resolve(token);
      },
    },
    clearAccess() {
      refreshes += 1;
    },
    fetch: (url, init) => {
      requests.push({ url, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return Promise.resolve(response);
    },
  });
  return { client, refreshes: () => refreshes, requests, tokens };
}

function exactJsonObject(bytes) {
  const empty = JSON.stringify({ value: '' });
  return { value: 'x'.repeat(bytes - Buffer.byteLength(empty)) };
}

async function rejectsMismatchedRunIntentResponses() {
  for (const [method, status] of [
    ['get', 200],
    ['cancel', 202],
  ]) {
    const h = clientHarness([jsonResponse(runIntent({ intent_id: OTHER_INTENT_ID }), status)]);
    await assert.rejects(h.client[method](INTENT_ID), /identity does not match/);
    assert.equal(h.requests.length, 1);
  }
}

describe('private RunIntent v2 envelope', () => {
  it('contains exactly the validated graph and authority-free job input', () => {
    const input = {
      source: 'prompt',
      prompt: 'Ship the requested change.',
      artifacts: [],
    };
    const envelope = buildRunIntentEnvelope(GRAPH, input);
    assert.deepEqual(envelope, {
      version: RUN_INTENT_VERSION,
      graph: GRAPH,
      input,
    });
    assert.equal(RUN_INTENT_VERSION, 'zeroshot.run-intent/v2');
    assert.deepEqual(Object.keys(envelope), ['version', 'graph', 'input']);
    assert.equal(
      /credentials|token|apiKey|environment|endpoint|settings|command|path|runtime/i.test(
        JSON.stringify(envelope)
      ),
      false
    );
    for (const authority of [
      'isolationProfile',
      'modelLevel',
      'provider',
      'providerProfile',
      'repository',
      'revision',
    ]) {
      assert.throws(
        () => buildRunIntentEnvelope(GRAPH, { ...input, [authority]: 'caller-owned' }),
        /forbidden field/
      );
    }
  });
});

describe('bounded authenticated RunIntent client', () => {
  it('submits to the organization endpoint with one opaque idempotency key', async () => {
    const h = clientHarness([jsonResponse(runIntent(), 202)]);
    const envelope = buildRunIntentEnvelope(GRAPH, { source: 'prompt' });
    const result = await h.client.submit({
      envelope,
      runtime: RUNTIME_BUNDLE,
      submissionKey: SUBMISSION_KEY,
      size: 'standard',
    });
    assert.equal(result.intent_id, INTENT_ID);
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.url, `https://target.example/api/v1/orgs/${ORGANIZATION_ID}/run-intents`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers.authorization, 'Bearer access-before-refresh');
    assert.equal(request.init.headers['idempotency-key'], SUBMISSION_KEY);
    const wrapper = JSON.parse(request.init.body);
    assert.deepEqual(Object.keys(wrapper), ['label', 'size', 'intent', 'runtime']);
    assert.equal(wrapper.label, 'zeroshot-cli');
    assert.equal(wrapper.size, 'standard');
    for (const field of ['intent', 'runtime']) {
      assert.match(wrapper[field], /^[A-Za-z0-9_-]+$/);
      assert.equal(wrapper[field].includes('='), false);
    }
    assert.equal(
      Buffer.from(wrapper.intent, 'base64url').toString('utf8'),
      JSON.stringify(envelope)
    );
    assert.equal(
      Buffer.from(wrapper.runtime, 'base64url').toString('utf8'),
      JSON.stringify(RUNTIME_BUNDLE)
    );
  });

  it('uses the same validated projection for explicit cancellation', async () => {
    const h = clientHarness([
      jsonResponse(runIntent({ state: 'cancelling', capsule_id: CAPSULE_ID }), 202),
    ]);
    const result = await h.client.cancel(INTENT_ID);
    assert.equal(result.state, 'cancelling');
    assert.equal(
      h.requests[0].url,
      `https://target.example/api/v1/orgs/${ORGANIZATION_ID}/run-intents/${INTENT_ID}`
    );
    assert.equal(h.requests[0].init.method, 'DELETE');
    assert.equal(Object.hasOwn(h.requests[0].init.headers, 'idempotency-key'), false);
  });

  it('rejects status and cancellation responses for a different intent', () =>
    rejectsMismatchedRunIntentResponses());
});

describe('bounded RunIntent authentication and bodies', () => {
  it('checks HTTP status before decoding and refreshes authentication exactly once', async () => {
    const h = clientHarness([
      new globalThis.Response('peer-controlled non-json', { status: 401 }),
      jsonResponse(runIntent(), 200),
    ]);
    const result = await h.client.get(INTENT_ID);
    assert.equal(result.intent_id, INTENT_ID);
    assert.equal(h.refreshes(), 1);
    assert.deepEqual(h.tokens, ['access-before-refresh', 'access-after-refresh']);
    assert.deepEqual(
      h.requests.map(({ init }) => init.headers.authorization),
      ['Bearer access-before-refresh', 'Bearer access-after-refresh']
    );
  });

  it('never performs a second refresh or decodes a repeated authorization refusal', async () => {
    const h = clientHarness([
      new globalThis.Response('not-json', { status: 401 }),
      new globalThis.Response('still-not-json', { status: 403 }),
    ]);
    await assert.rejects(
      h.client.get(INTENT_ID),
      (error) => error instanceof RunIntentHttpError && error.status === 403
    );
    assert.equal(h.refreshes(), 1);
    assert.equal(h.requests.length, 2);
  });

  it('does not rotate authentication for an authenticated authorization refusal', async () => {
    const h = clientHarness([new globalThis.Response('peer-controlled non-json', { status: 403 })]);
    await assert.rejects(
      h.client.get(INTENT_ID),
      (error) => error instanceof RunIntentHttpError && error.status === 403
    );
    assert.equal(h.refreshes(), 0);
    assert.equal(h.requests.length, 1);
  });
});

describe('opaque RunIntent submit bodies', () => {
  it('serializes each opaque submit field exactly once', async () => {
    const h = clientHarness([jsonResponse(runIntent(), 202)]);
    let intentSerializations = 0;
    let runtimeSerializations = 0;
    await h.client.submit({
      envelope: {
        toJSON() {
          intentSerializations += 1;
          return { version: RUN_INTENT_VERSION, graph: GRAPH, input: { source: 'prompt' } };
        },
      },
      runtime: {
        toJSON() {
          runtimeSerializations += 1;
          return RUNTIME_BUNDLE;
        },
      },
      submissionKey: SUBMISSION_KEY,
    });
    assert.equal(intentSerializations, 1);
    assert.equal(runtimeSerializations, 1);
  });

  it('bounds decoded intent, decoded runtime, complete request, and response bodies', async () => {
    const runtimeAtLimit = exactJsonObject(MAX_RUNTIME_BUNDLE_BYTES);
    const intentAtCombinedLimit = exactJsonObject(
      MAX_RUN_INTENT_DISPATCH_BYTES - MAX_RUNTIME_BUNDLE_BYTES - 4
    );
    const boundary = clientHarness([jsonResponse(runIntent(), 202)]);
    await boundary.client.submit({
      envelope: intentAtCombinedLimit,
      runtime: runtimeAtLimit,
      submissionKey: SUBMISSION_KEY,
    });
    assert.ok(Buffer.byteLength(boundary.requests[0].init.body) <= MAX_RUN_INTENT_REQUEST_BYTES);

    const oversizedDispatch = clientHarness([]);
    assert.throws(
      () =>
        oversizedDispatch.client.submit({
          envelope: exactJsonObject(
            MAX_RUN_INTENT_DISPATCH_BYTES - MAX_RUNTIME_BUNDLE_BYTES - 3
          ),
          runtime: runtimeAtLimit,
          submissionKey: SUBMISSION_KEY,
        }),
      /payloads exceed the decoded dispatch size bound/
    );
    assert.equal(oversizedDispatch.requests.length, 0);

    const oversizedIntent = clientHarness([]);
    assert.throws(
      () =>
        oversizedIntent.client.submit({
          envelope: exactJsonObject(MAX_RUN_INTENT_BYTES + 1),
          runtime: RUNTIME_BUNDLE,
          submissionKey: SUBMISSION_KEY,
          size: 'standard',
        }),
      /intent exceeds the decoded size bound/
    );
    assert.equal(oversizedIntent.requests.length, 0);

    const oversizedRuntime = clientHarness([]);
    assert.throws(
      () =>
        oversizedRuntime.client.submit({
          envelope: buildRunIntentEnvelope(GRAPH, { source: 'prompt' }),
          runtime: exactJsonObject(MAX_RUNTIME_BUNDLE_BYTES + 1),
          submissionKey: SUBMISSION_KEY,
          size: 'standard',
        }),
      /runtime bundle exceeds the decoded size bound/
    );
    assert.equal(oversizedRuntime.requests.length, 0);

    const oversizedResponse = clientHarness([
      new globalThis.Response('x'.repeat(MAX_RUN_INTENT_RESPONSE_BYTES + 1), {
        status: 200,
      }),
    ]);
    await assert.rejects(oversizedResponse.client.get(INTENT_ID), /response exceeds/);
  });
});

describe('RunIntent lifecycle projection', () => {
  it('rejects every malformed field and unknown state or shape', () => {
    const failed = runIntent({
      state: 'failed',
      error_code: 'runtime_failed',
      terminal_at: NOW,
    });
    const malformed = [
      null,
      [],
      { ...runIntent(), unknown: true },
      { ...runIntent(), intent_id: 'not-a-uuid' },
      { ...runIntent(), state: 'done' },
      { ...runIntent(), waiting_reason: 'later' },
      { ...runIntent(), capsule_id: 'cap-1' },
      { ...runIntent(), result: [] },
      { ...runIntent(), error_code: 42 },
      { ...failed, error_code: '1runtime_failed' },
      { ...failed, error_code: 'Runtime_failed' },
      { ...failed, error_code: `a${'0'.repeat(64)}` },
      { ...runIntent(), submitted_at: 'yesterday' },
      { ...runIntent(), terminal_at: 7 },
    ];
    for (const value of malformed) {
      assert.throws(() => validateRunIntent(value), /invalid RunIntent/);
    }
    assert.deepEqual(validateRunIntent(runIntent()), runIntent());
  });
});

describe('RunIntent observation', () => {
  it('polls validated states to a terminal result without invoking cancellation', async () => {
    const calls = [];
    const states = [
      runIntent({ state: 'running', capsule_id: CAPSULE_ID }),
      runIntent({
        state: 'succeeded',
        capsule_id: CAPSULE_ID,
        result: { summary: 'done' },
        terminal_at: NOW,
      }),
    ];
    const terminal = await followRunIntent(
      {
        get(id) {
          calls.push(['get', id]);
          return states.shift();
        },
        cancel() {
          calls.push(['cancel']);
        },
      },
      runIntent(),
      {
        sleep: () => Promise.resolve(),
        onChange: (intent) => calls.push(['state', intent.state]),
      }
    );
    assert.equal(terminal.state, 'succeeded');
    assert.equal(
      calls.some(([name]) => name === 'cancel'),
      false
    );
    assert.deepEqual(
      calls.filter(([name]) => name === 'state'),
      [
        ['state', 'queued'],
        ['state', 'running'],
        ['state', 'succeeded'],
      ]
    );
  });
});
