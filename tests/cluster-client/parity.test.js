'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const {
  ClusterClient,
  WatchSubscriptionClient,
  LogsSubscriptionClient,
  AgentAttachSubscriptionClient,
} = require('../../lib/cluster/cjs/index.js');

const openrpc = require(
  path.join('..', '..', 'protocol', 'openengine-cluster', 'v1', 'openrpc.json')
);

// AC1: every method in openrpc.json's methods array (the wire authority) must have a
// corresponding TypeScript client method, driven off the file's methods list rather than a
// hardcoded copy of it here.
const UNARY_METHODS = new Set([
  'initialize',
  'plan',
  'apply',
  'update',
  'stop',
  'retry',
  'resubmit',
  'delete',
  'get',
]);
const SUBSCRIPTION_CLIENTS = {
  watch: [WatchSubscriptionClient, 'watch'],
  logs: [LogsSubscriptionClient, 'logs'],
  'agent/attach': [AgentAttachSubscriptionClient, 'agentAttach'],
};

test('openrpc.json declares the methods this parity test expects (fixture sanity)', () => {
  assert.ok(Array.isArray(openrpc.methods) && openrpc.methods.length > 0);
});

test('every openrpc method has a corresponding TypeScript ClusterClient/subscription-client method', () => {
  const missing = [];
  for (const method of openrpc.methods) {
    const name = method.name;
    if (UNARY_METHODS.has(name)) {
      if (typeof ClusterClient.prototype[name] !== 'function') missing.push(name);
      continue;
    }
    const mapping = SUBSCRIPTION_CLIENTS[name];
    if (!mapping) {
      missing.push(`${name} (no client mapping known to this test)`);
      continue;
    }
    const [ClientClass, methodName] = mapping;
    if (typeof ClientClass.prototype[methodName] !== 'function') missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `openrpc methods missing a TypeScript client method: ${missing.join(', ')}`
  );
});

test('every declared TypeScript client method matches a real openrpc method name', () => {
  const declaredNames = new Set(openrpc.methods.map((method) => method.name));
  for (const name of UNARY_METHODS) {
    assert.ok(declaredNames.has(name), `${name} is not an openrpc method`);
  }
  for (const name of Object.keys(SUBSCRIPTION_CLIENTS)) {
    assert.ok(declaredNames.has(name), `${name} is not an openrpc method`);
  }
});
