/**
 * Cross-language wire-format parity: replays the authoritative
 * protocol/openengine-cluster/v1/goldens/*.ndjson request/response sessions and the
 * watch/logs/agent-attach *-session.json event fixtures through this package's TS client and
 * subscription clients, asserting the decoded shape matches the golden exactly.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ClusterClient,
  ClusterRpcError,
  ClusterInvalidResponseError,
} = require('../../lib/cluster');
const { parseJsonRpcResponse } = require('../../lib/cluster/cluster-client');
const { watch } = require('../../lib/cluster/watch-subscription');
const { logs } = require('../../lib/cluster/logs-subscription');
const { agentAttach } = require('../../lib/cluster/agent-attach-subscription');
const { BoundedChannel } = require('../../lib/cluster/transport');

const GOLDENS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'protocol',
  'openengine-cluster',
  'v1',
  'goldens'
);

function readNdjsonPairs(filename) {
  const lines = fs
    .readFileSync(path.join(GOLDENS_DIR, filename), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.strictEqual(
    lines.length % 2,
    0,
    `${filename} must contain alternating request/response lines`
  );
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    pairs.push({ request: lines[i], response: lines[i + 1] });
  }
  return pairs;
}

function readSessionEvents(filename) {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_DIR, filename), 'utf8'));
}

/** Replays `pairs` in order against a fresh transport that ignores the golden's own request id
 * (this package's ClusterClient mints its own) and instead echoes back each golden response with
 * the caller's actual id substituted in, one pair per call, in strict sequence. */
function makeSequentialTransport(pairs) {
  let index = 0;
  return {
    request: (requestJson) => {
      const req = JSON.parse(requestJson);
      const golden = pairs[index];
      index += 1;
      assert.ok(golden, 'ran out of golden request/response pairs to replay');
      const goldenResponse = JSON.parse(golden.response);
      if ('error' in goldenResponse) {
        return Promise.resolve(
          JSON.stringify({ jsonrpc: '2.0', id: req.id, error: goldenResponse.error })
        );
      }
      return Promise.resolve(
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: goldenResponse.result })
      );
    },
  };
}

const METHOD_CALLS = {
  initialize: (client, params) => client.initializeWithVersion(params.protocolVersion),
  plan: (client, params) => client.plan(params),
  apply: (client, params) => client.apply(params),
  get: (client, params) => client.get(params),
  update: (client, params) => client.update(params),
  stop: (client, params) => client.stop(params),
  retry: (client, params) => client.retry(params),
  resubmit: (client, params) => client.resubmit(params),
  delete: (client, params) => client.delete(params),
};

async function replaySession(filename) {
  const pairs = readNdjsonPairs(filename);
  const transport = makeSequentialTransport(pairs);
  const client = new ClusterClient(transport);

  for (const { request, response } of pairs) {
    const req = JSON.parse(request);
    const res = JSON.parse(response);
    const call = METHOD_CALLS[req.method];
    assert.ok(
      call,
      `${filename}: no ClusterClient method mapped for golden method "${req.method}"`
    );

    if ('error' in res) {
      await assert.rejects(call(client, req.params), (error) => {
        assert.ok(
          error instanceof ClusterRpcError,
          `${filename}/${req.method}: expected ClusterRpcError`
        );
        assert.strictEqual(error.code, res.error.code);
        assert.deepStrictEqual(error.data, res.error.data ?? null);
        return true;
      });
    } else {
      const decoded = await call(client, req.params);
      assert.deepStrictEqual(
        decoded,
        res.result,
        `${filename}/${req.method}: decoded result must match the golden`
      );
    }
  }
}

describe('cluster protocol goldens: session replay', function () {
  const SESSION_FILES = [
    'initialize.ndjson',
    'get-empty.ndjson',
    'admission-lifecycle.ndjson',
    'admission-errors.ndjson',
    'lifecycle-controls.ndjson',
    'lifecycle-delete.ndjson',
    'lifecycle-resubmit.ndjson',
  ];

  for (const file of SESSION_FILES) {
    it(`replays ${file} through ClusterClient and matches every decoded result/error`, async function () {
      await replaySession(file);
    });
  }
});

describe('cluster protocol goldens: wire-level edge cases', function () {
  it('incompatible-version.ndjson decodes to a ClusterRpcError carrying UNSUPPORTED_PROTOCOL_VERSION', function () {
    const [{ request, response }] = readNdjsonPairs('incompatible-version.ndjson');
    const req = JSON.parse(request);
    assert.throws(
      () => parseJsonRpcResponse(response, req.id),
      (error) => {
        assert.ok(error instanceof ClusterRpcError);
        assert.strictEqual(error.data.code, 'UNSUPPORTED_PROTOCOL_VERSION');
        return true;
      }
    );
  });

  it('invalid-params.ndjson decodes the raw JSON-RPC -32602 error with no domain data', function () {
    const [{ request, response }] = readNdjsonPairs('invalid-params.ndjson');
    const req = JSON.parse(request);
    assert.throws(
      () => parseJsonRpcResponse(response, req.id),
      (error) => {
        assert.ok(error instanceof ClusterRpcError);
        assert.strictEqual(error.code, -32602);
        assert.strictEqual(error.data, null);
        return true;
      }
    );
  });

  it('unknown-method.ndjson decodes the raw JSON-RPC -32601 error with no domain data', function () {
    const [{ request, response }] = readNdjsonPairs('unknown-method.ndjson');
    const req = JSON.parse(request);
    assert.throws(
      () => parseJsonRpcResponse(response, req.id),
      (error) => {
        assert.ok(error instanceof ClusterRpcError);
        assert.strictEqual(error.code, -32601);
        assert.strictEqual(error.data, null);
        return true;
      }
    );
  });

  it('malformed-request.ndjson: a null-id response can never be correlated to a request, so it is rejected as invalid', function () {
    const [{ response }] = readNdjsonPairs('malformed-request.ndjson');
    assert.throws(() => parseJsonRpcResponse(response, 6), ClusterInvalidResponseError);
  });

  it('rejected-batch.ndjson: a null-id response is rejected as invalid rather than matched to any pending request', function () {
    const [{ response }] = readNdjsonPairs('rejected-batch.ndjson');
    assert.throws(() => parseJsonRpcResponse(response, 1), ClusterInvalidResponseError);
  });
});

describe('cluster protocol goldens: subscription event replay', function () {
  it('watch-session.json events decode in order with matching cursor/runId/event', async function () {
    const entries = readSessionEvents('watch-session.json');
    const channel = new BoundedChannel(1024);
    const transport = {
      openSubscription: (requestJson, id) =>
        Promise.resolve({
          line: JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { subscriptionId: 'sub-1', runId: 'run-1', atCursor: null },
          }),
          subscription: { channel, overflowed: { value: false } },
        }),
      cancelSubscription: () => Promise.resolve(),
      cancelRequest: () => Promise.resolve(),
      nextWatchRequestId: () => 'watch-1',
    };
    const { stream } = await watch(transport, {});
    for (const entry of entries) {
      channel.trySend(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: entry }));
    }
    for (const entry of entries) {
      const item = await stream.next();
      assert.strictEqual(item.value.kind, 'event');
      assert.strictEqual(item.value.cursor, entry.cursor);
      assert.strictEqual(item.value.runId, entry.runId);
      assert.deepStrictEqual(item.value.event, entry.event);
    }
  });

  it('logs-session.json events decode in order with matching record and no cursor/runId', async function () {
    const entries = readSessionEvents('logs-session.json');
    const channel = new BoundedChannel(1024);
    const transport = {
      openSubscription: (requestJson, id) =>
        Promise.resolve({
          line: JSON.stringify({ jsonrpc: '2.0', id, result: { subscriptionId: 'sub-1' } }),
          subscription: { channel, overflowed: { value: false } },
        }),
      cancelSubscription: () => Promise.resolve(),
      cancelRequest: () => Promise.resolve(),
      nextWatchRequestId: () => 'watch-1',
    };
    const { stream } = await logs(transport, {});
    for (const entry of entries) {
      channel.trySend(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: entry }));
    }
    for (const entry of entries) {
      const item = await stream.next();
      assert.strictEqual(item.value.kind, 'event');
      assert.deepStrictEqual(item.value.event, entry.record);
    }
  });

  it('agent-attach-session.json events decode in order with matching event and no cursor/runId', async function () {
    const entries = readSessionEvents('agent-attach-session.json');
    const channel = new BoundedChannel(1024);
    const transport = {
      openSubscription: (requestJson, id) =>
        Promise.resolve({
          line: JSON.stringify({ jsonrpc: '2.0', id, result: { subscriptionId: 'sub-1' } }),
          subscription: { channel, overflowed: { value: false } },
        }),
      cancelSubscription: () => Promise.resolve(),
      cancelRequest: () => Promise.resolve(),
      nextWatchRequestId: () => 'watch-1',
    };
    const { stream } = await agentAttach(transport, { execution: 'exec-1' });
    for (const entry of entries) {
      channel.trySend(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: entry }));
    }
    for (const entry of entries) {
      const item = await stream.next();
      assert.strictEqual(item.value.kind, 'event');
      assert.deepStrictEqual(item.value.event, entry.event);
    }
  });
});
