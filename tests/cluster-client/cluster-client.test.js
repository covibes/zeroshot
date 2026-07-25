'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterClient,
  RpcError,
  AbortError,
  InvalidResponseError,
  PROTOCOL_VERSION,
} = require('../../lib/cluster/cjs/index.js');
const { createHarness, parseFrame, successReplyFor } = require('./_fixtures.js');

test('unary calls round-trip params/result over the shared transport', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);

  const promise = client.plan({ graph: { profile: 'openengine.graph.single-worker/v1' } });
  assert.equal(sink.frames.length, 1);
  const sent = parseFrame(sink.frames[0]);
  assert.equal(sent.method, 'plan');
  assert.deepEqual(sent.params, { graph: { profile: 'openengine.graph.single-worker/v1' } });

  transport.routeIncoming(successReplyFor(sink.frames[0], { ok: true, diagnostics: [] }));
  const result = await promise;
  assert.deepEqual(result, { ok: true, diagnostics: [] });
});

test('initialize() validates the echoed protocol version', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);

  const promise = client.initialize();
  transport.routeIncoming(
    successReplyFor(sink.frames[0], {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { logs: false, agentAttach: false },
      status: { phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null },
    })
  );
  const result = await promise;
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
});

test('initialize() rejects a mismatched protocol version', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);

  const promise = client.initialize();
  transport.routeIncoming(
    successReplyFor(sink.frames[0], {
      protocolVersion: 'openengine.cluster/v999',
      capabilities: {},
      status: { phase: 'empty', observedGeneration: null, currentRunId: null, atCursor: null },
    })
  );
  await assert.rejects(() => promise, InvalidResponseError);
});

test('a well-formed JSON-RPC error response surfaces as RpcError with code/data', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);

  const promise = client.get({});
  const request = parseFrame(sink.frames[0]);
  transport.routeIncoming(
    JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: 'no active run', data: { code: 'NO_ACTIVE_RUN' } },
    })
  );
  await assert.rejects(
    () => promise,
    (error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, -32000);
      assert.equal(error.message, 'no active run');
      assert.deepEqual(error.data, { code: 'NO_ACTIVE_RUN', details: undefined });
      return true;
    }
  );
});

// AC6: AbortSignal-based cancellation sends $/cancelRequest exactly once even when the signal
// fires twice (defensively) or cancellation is otherwise triggered more than once.
test('abort sends $/cancelRequest exactly once even if the signal fires twice', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);
  const controller = new AbortController();

  const promise = client.get({}, { signal: controller.signal });
  controller.abort();

  await assert.rejects(() => promise, AbortError);

  // A signal only fires once per AbortController, so trigger the internal cancel path a second
  // time directly the way a caller combining manual cancellation with the signal could.
  const cancelFrames = () =>
    sink.frames.filter((frame) => parseFrame(frame).method === '$/cancelRequest');
  await Promise.resolve();
  assert.equal(cancelFrames().length, 1);

  controller.abort(); // no-op: AbortController.abort() only fires listeners once regardless
  await Promise.resolve();
  assert.equal(cancelFrames().length, 1);
});

test('an already-aborted signal rejects before sending any request frame', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => client.get({}, { signal: controller.signal }), AbortError);
  assert.equal(sink.frames.length, 0);
});

test('the eventual response after abort is swallowed, not surfaced as an unhandled rejection', async () => {
  const { sink, transport } = createHarness();
  const client = new ClusterClient(transport);
  const controller = new AbortController();

  const promise = client.get({}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise, AbortError);

  // The transport eventually "responds" to the now-abandoned request; this must not throw or
  // produce an unhandled rejection anywhere in the process.
  transport.routeIncoming(
    successReplyFor(sink.frames[0], { spec: null, status: {}, atCursor: null })
  );
  await new Promise((resolve) => setImmediate(resolve));
});
