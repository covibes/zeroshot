'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  WatchSubscriptionClient,
  LogsSubscriptionClient,
  AgentAttachSubscriptionClient,
  parseUnaryResponseLine,
} = require('../../lib/cluster/cjs/index.js');
const { createHarness, successReplyFor } = require('./_fixtures.js');

const GOLDENS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'protocol',
  'openengine-cluster',
  'v1',
  'goldens'
);

function loadNdjsonPairs(filename) {
  const raw = fs.readFileSync(path.join(GOLDENS_DIR, filename), 'utf8').trim();
  const lines = raw.split('\n');
  assert.equal(lines.length % 2, 0, `${filename} must contain request/response line pairs`);
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    pairs.push({ requestLine: lines[i], responseLine: lines[i + 1] });
  }
  return pairs;
}

// Cross-language wire compatibility: every request/response pair recorded by the Rust
// implementation's goldens must parse cleanly (or fail identically) through this client's
// generic unary response parser -- driven off the golden files on disk, not a hardcoded list.
test('every ndjson golden response line parses through parseUnaryResponseLine as the Rust client would', () => {
  const files = fs.readdirSync(GOLDENS_DIR).filter((entry) => entry.endsWith('.ndjson'));
  assert.ok(files.length >= 10, 'expected the full set of protocol goldens to be present on disk');

  for (const file of files) {
    for (const { requestLine, responseLine } of loadNdjsonPairs(file)) {
      const request = JSON.parse(requestLine);
      const response = JSON.parse(responseLine);
      if ('error' in response) {
        assert.throws(
          () => parseUnaryResponseLine(responseLine, request.id),
          undefined,
          `${file}: expected error response to throw`
        );
      } else {
        const result = parseUnaryResponseLine(responseLine, request.id);
        assert.deepEqual(
          result,
          response.result,
          `${file}: parsed result must match the golden result`
        );
      }
    }
  }
});

function loadSessionGolden(filename) {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_DIR, filename), 'utf8'));
}

test('watch-session.json events replay through WatchSubscriptionEventStream unchanged', async () => {
  const golden = loadSessionGolden('watch-session.json');
  assert.ok(golden.length >= 3);

  const harness = createHarness();
  const client = new WatchSubscriptionClient(harness.transport);
  const promise = client.watch({});
  const requestFrame = harness.sink.frames.at(-1);
  harness.transport.routeIncoming(
    successReplyFor(requestFrame, {
      subscriptionId: golden[0].subscriptionId,
      runId: golden[0].runId,
    })
  );
  const { stream } = await promise;

  for (const params of golden) {
    harness.transport.routeIncoming(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }));
  }

  for (const params of golden) {
    const outcome = await stream.next();
    assert.equal(outcome.type, 'event');
    assert.equal(outcome.runId, params.runId);
    assert.equal(outcome.cursor, params.cursor);
    assert.deepEqual(outcome.event, params.event);
  }
});

test('logs-session.json records replay through CursorlessEventStream unchanged', async () => {
  const golden = loadSessionGolden('logs-session.json');
  assert.ok(golden.length >= 1);

  const harness = createHarness();
  const client = new LogsSubscriptionClient(harness.transport);
  const promise = client.logs({}, { logs: true });
  const requestFrame = harness.sink.frames.at(-1);
  harness.transport.routeIncoming(
    successReplyFor(requestFrame, { subscriptionId: golden[0].subscriptionId })
  );
  const { stream } = await promise;

  for (const params of golden) {
    harness.transport.routeIncoming(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }));
  }

  for (const params of golden) {
    const outcome = await stream.next();
    assert.equal(outcome.type, 'event');
    assert.deepEqual(outcome.event, params.record);
  }
});

test('agent-attach-session.json events replay through CursorlessEventStream unchanged', async () => {
  const golden = loadSessionGolden('agent-attach-session.json');
  assert.ok(golden.length >= 1);

  const harness = createHarness();
  const client = new AgentAttachSubscriptionClient(harness.transport);
  const promise = client.agentAttach({ execution: 'exec-1' }, { agentAttach: true });
  const requestFrame = harness.sink.frames.at(-1);
  harness.transport.routeIncoming(
    successReplyFor(requestFrame, { subscriptionId: golden[0].subscriptionId })
  );
  const { stream } = await promise;

  for (const params of golden) {
    harness.transport.routeIncoming(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }));
  }

  for (const params of golden) {
    const outcome = await stream.next();
    assert.equal(outcome.type, 'event');
    assert.deepEqual(outcome.event, params.event);
  }
});
