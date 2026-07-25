/**
 * Coverage for every ClusterClient unary method: outgoing request shape, successful result
 * pass-through, and typed error mapping for every documented domain error code.
 */
const assert = require('assert');
const {
  ClusterClient,
  ClusterAbortError,
  ClusterInvalidResponseError,
  ClusterRpcError,
  PROTOCOL_VERSION,
} = require('../../lib/cluster');

const GRAPH_SPEC = {
  initialInput: { kind: 'null' },
  policy: { default: 'deny', policy: 'policy.default@1' },
  profile: 'openengine.graph.single-worker/v1',
  root: {
    attempts: 1,
    input: { kind: 'null' },
    inputBindings: [],
    kind: 'step',
    name: 'worker',
    output: { kind: 'null' },
    timeoutMs: 1000,
    worker: 'legacy.zeroshot.ship@1',
    writeBindings: [],
  },
};

/** A transport whose `request()` decodes the outgoing envelope, records it, and replies with
 * whatever `respond(request)` returns -- either `{ result }` or `{ error }`. */
function mockTransport(respond) {
  const sent = [];
  return {
    sent,
    request: (requestJson) => {
      const request = JSON.parse(requestJson);
      sent.push(request);
      const reply = respond(request);
      if ('error' in reply) {
        return Promise.resolve(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, error: reply.error })
        );
      }
      return Promise.resolve(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: reply.result })
      );
    },
  };
}

const METHOD_CASES = [
  {
    method: 'initialize',
    call: (client) => client.initialize(),
    expectedParams: { protocolVersion: PROTOCOL_VERSION },
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { graphProfiles: [], logs: false, agentAttach: false },
      status: { phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null },
    },
  },
  {
    method: 'plan',
    call: (client) => client.plan({ graph: GRAPH_SPEC }),
    expectedParams: { graph: GRAPH_SPEC },
    result: { ok: true, diagnostics: [] },
  },
  {
    method: 'apply',
    call: (client) => client.apply({ graph: GRAPH_SPEC, idempotencyKey: 'k1', ifGeneration: 0 }),
    expectedParams: { graph: GRAPH_SPEC, idempotencyKey: 'k1', ifGeneration: 0 },
    result: { deduped: false, phase: 'running', generation: 1, runId: 'run-1' },
  },
  {
    method: 'get',
    call: (client) => client.get(),
    expectedParams: {},
    result: {
      status: { phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null },
    },
  },
  {
    method: 'update',
    call: (client) => client.update({ idempotencyKey: 'k1', ifGeneration: 1, suspended: true }),
    expectedParams: { idempotencyKey: 'k1', ifGeneration: 1, suspended: true },
    result: { atCursor: 'c1', deduped: false, generation: 1 },
  },
  {
    method: 'stop',
    call: (client) => client.stop({ idempotencyKey: 'k1', ifGeneration: 1, mode: 'drain' }),
    expectedParams: { idempotencyKey: 'k1', ifGeneration: 1, mode: 'drain' },
    result: {
      acceptedMode: 'drain',
      atCursor: 'c1',
      deduped: false,
      effectiveMode: 'drain',
      generation: 1,
      operational: { labels: {}, logLevel: 'info', dispatchState: 'active', inFlight: 0 },
      phase: 'running',
    },
  },
  {
    method: 'retry',
    call: (client) => client.retry({ idempotencyKey: 'k1', ifGeneration: 1 }),
    expectedParams: { idempotencyKey: 'k1', ifGeneration: 1 },
    result: {
      atCursor: 'c1',
      deduped: false,
      generation: 1,
      operational: { labels: {}, logLevel: 'info', dispatchState: 'active', inFlight: 0 },
      phase: 'running',
      retriedTurnId: 't1',
      retryTurnId: 't2',
    },
  },
  {
    method: 'resubmit',
    call: (client) => client.resubmit({ idempotencyKey: 'k1', ifGeneration: 1, ifRunId: 'run-1' }),
    expectedParams: { idempotencyKey: 'k1', ifGeneration: 1, ifRunId: 'run-1' },
    result: {
      atCursor: 'c1',
      deduped: false,
      generation: 2,
      operational: { labels: {}, logLevel: 'info', dispatchState: 'active', inFlight: 0 },
      phase: 'running',
      priorRunId: 'run-1',
      runId: 'run-2',
    },
  },
  {
    method: 'delete',
    call: (client) => client.delete({ idempotencyKey: 'k1', ifGeneration: 1 }),
    expectedParams: { idempotencyKey: 'k1', ifGeneration: 1 },
    result: { deduped: false, deleted: true, phase: 'deleting' },
  },
];

describe('ClusterClient unary methods', function () {
  for (const testCase of METHOD_CASES) {
    it(`${testCase.method}: sends the correct method/params and returns the decoded result`, async function () {
      const transport = mockTransport(() => ({ result: testCase.result }));
      const client = new ClusterClient(transport);
      const result = await testCase.call(client);

      assert.strictEqual(transport.sent.length, 1);
      assert.strictEqual(transport.sent[0].jsonrpc, '2.0');
      assert.strictEqual(transport.sent[0].method, testCase.method);
      assert.deepStrictEqual(transport.sent[0].params, testCase.expectedParams);
      assert.deepStrictEqual(result, testCase.result);
    });
  }

  it('assigns sequential integer request ids across calls', async function () {
    const transport = mockTransport(() => ({ result: { ok: true } }));
    const client = new ClusterClient(transport);
    await client.get();
    await client.get();
    assert.deepStrictEqual(
      transport.sent.map((r) => r.id),
      [1, 2]
    );
  });

  it('initialize() rejects with ClusterInvalidResponseError on a protocol version mismatch', async function () {
    const transport = mockTransport(() => ({
      result: {
        protocolVersion: 'openengine.cluster/v999',
        capabilities: { graphProfiles: [], logs: false, agentAttach: false },
        status: { phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null },
      },
    }));
    const client = new ClusterClient(transport);
    await assert.rejects(client.initialize(), ClusterInvalidResponseError);
  });

  it('a response with a mismatched id is rejected as ClusterInvalidResponseError', async function () {
    const transport = {
      request: (requestJson) => {
        const request = JSON.parse(requestJson);
        return Promise.resolve(
          JSON.stringify({ jsonrpc: '2.0', id: request.id === 1 ? 999 : request.id, result: {} })
        );
      },
    };
    const client = new ClusterClient(transport);
    await assert.rejects(client.get(), ClusterInvalidResponseError);
  });
});

describe('ClusterClient domain error mapping', function () {
  const DOMAIN_ERROR_CODES = [
    'UNSUPPORTED_PROTOCOL_VERSION',
    'SCHEMA_VIOLATION',
    'GENERATION_CONFLICT',
    'RUN_CONFLICT',
    'IDEMPOTENCY_REUSE',
    'INVALID_PHASE',
    'CANCELLED',
    'NO_RETRYABLE_FRONTIER',
    'NOT_FOUND',
    'GONE',
  ];

  for (const code of DOMAIN_ERROR_CODES) {
    it(`maps a JSON-RPC application error with data.code=${code} to a ClusterRpcError`, async function () {
      const transport = mockTransport(() => ({
        error: {
          code: -32000,
          message: `domain error ${code}`,
          data: { code, details: { some: 'detail' } },
        },
      }));
      const client = new ClusterClient(transport);
      await assert.rejects(client.get(), (error) => {
        assert.ok(error instanceof ClusterRpcError);
        assert.strictEqual(error.code, -32000);
        assert.strictEqual(error.data.code, code);
        return true;
      });
    });
  }
});

describe('ClusterClient AbortSignal handling', function () {
  it('rejects (never throws synchronously) when the signal is already aborted', async function () {
    const transport = mockTransport(() => ({ result: {} }));
    const controller = new AbortController();
    controller.abort();
    const client = new ClusterClient(transport);

    let call;
    assert.doesNotThrow(() => {
      call = client.get({}, { signal: controller.signal });
    });
    await assert.rejects(call, ClusterAbortError);
    assert.strictEqual(
      transport.sent.length,
      0,
      'an already-aborted call must never reach the transport'
    );
  });

  it('cancels the in-flight request and rejects exactly once when aborted mid-flight', async function () {
    let resolveRequest;
    let cancelRequestCalls = 0;
    const transport = {
      request: () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
      cancelRequest: () => {
        cancelRequestCalls += 1;
        return Promise.resolve();
      },
      openSubscription: () => Promise.reject(new Error('unused')),
      cancelSubscription: () => Promise.resolve(),
      nextWatchRequestId: () => 'unused',
    };
    const client = new ClusterClient(transport);
    const controller = new AbortController();

    const call = client.get({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(call, ClusterAbortError);
    assert.strictEqual(cancelRequestCalls, 1);

    // A late resolution of the underlying transport promise must not change the outcome.
    resolveRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  });
});
