'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const protocolDir = path.join(repoRoot, 'protocol', 'openengine-cluster', 'v1');
const goldensDir = path.join(protocolDir, 'goldens');

const openrpc = JSON.parse(fs.readFileSync(path.join(protocolDir, 'openrpc.json'), 'utf8'));

const cluster = require('../../lib/cluster/cjs/index.js');
const methods = require('../../lib/cluster/cjs/generated/methods.js');
const guards = require('../../lib/cluster/cjs/json-guards.js');

const UNARY_TO_CLIENT_METHOD = {
  initialize: 'initialize',
  plan: 'plan',
  apply: 'apply',
  get: 'get',
  update: 'update',
  stop: 'stop',
  retry: 'retry',
  resubmit: 'resubmit',
  delete: 'delete',
};

const SUBSCRIPTION_TO_STREAM_CLASS = {
  watch: 'WatchSubscriptionStream',
  logs: 'LogsSubscriptionStream',
  'agent/attach': 'AgentAttachSubscriptionStream',
};

test('every openrpc method has a ClusterClient method or a subscription stream class', () => {
  assert.ok(openrpc.methods.length > 0);
  for (const method of openrpc.methods) {
    const unaryName = UNARY_TO_CLIENT_METHOD[method.name];
    if (unaryName) {
      assert.equal(
        typeof cluster.ClusterClient.prototype[unaryName],
        'function',
        `missing ClusterClient.${unaryName} for openrpc method "${method.name}"`
      );
      continue;
    }
    const streamClassName = SUBSCRIPTION_TO_STREAM_CLASS[method.name];
    assert.ok(
      streamClassName,
      `unrecognized openrpc method "${method.name}" -- update protocol-parity.test.js`
    );
    assert.equal(
      typeof cluster[streamClassName],
      'function',
      `missing ${streamClassName} for openrpc method "${method.name}"`
    );
  }
});

test('generated UNARY_METHODS/SUBSCRIPTION_METHODS exactly match openrpc.json', () => {
  const generated = [...methods.UNARY_METHODS, ...methods.SUBSCRIPTION_METHODS].slice().sort();
  const fromOpenrpc = openrpc.methods.map((method) => method.name).sort();
  assert.deepEqual(generated, fromOpenrpc);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readNdjsonLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

test('every watch-session.json event validates as an EventNotification', () => {
  const entries = readJson(path.join(goldensDir, 'watch-session.json'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(
      guards.isEventNotificationParams(entry),
      `not a valid EventNotification: ${JSON.stringify(entry)}`
    );
  }
});

test('every logs-session.json record validates as a LogEventNotificationWire', () => {
  const entries = readJson(path.join(goldensDir, 'logs-session.json'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(
      guards.isLogEventNotificationParams(entry),
      `not a valid LogEventNotificationWire: ${JSON.stringify(entry)}`
    );
  }
});

test('every agent-attach-session.json event validates as an AgentAttachEventNotification', () => {
  const entries = readJson(path.join(goldensDir, 'agent-attach-session.json'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(
      guards.isAgentAttachEventNotificationParams(entry),
      `not a valid AgentAttachEventNotification: ${JSON.stringify(entry)}`
    );
  }
});

test('every *.ndjson golden response line parses through parseIncomingMessage without structural failure', () => {
  const files = fs.readdirSync(goldensDir).filter((file) => file.endsWith('.ndjson'));
  assert.ok(files.length > 0);

  for (const file of files) {
    const lines = readNdjsonLines(path.join(goldensDir, file));
    for (const line of lines) {
      const raw = JSON.parse(line);
      const looksLikeResponse = 'result' in raw || 'error' in raw;
      if (!looksLikeResponse) continue; // an outgoing request/notification line, not a server response

      if (raw.jsonrpc !== '2.0') {
        // Deliberately malformed fixture (e.g. malformed-request.ndjson): the wire authority
        // itself rejects it, and so must this client -- but safely, not with a raw crash.
        assert.throws(
          () => guards.parseIncomingMessage(line),
          `${file}: expected parseIncomingMessage to reject a non-2.0 envelope`
        );
        continue;
      }

      const message = guards.parseIncomingMessage(line);
      if ('error' in raw) {
        assert.equal(message.kind, 'error', `${file}: expected an error-kind message`);
      } else {
        assert.equal(message.kind, 'success', `${file}: expected a success-kind message`);
      }
    }
  }
});
