'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveHostedRuntime } = require('../../private/hosted-cli-candidate/runtime-config');

const BASE_REVISION = 'b'.repeat(40);
const RUNTIME_CONFIG_PATH = path.join(__dirname, 'fixtures', 'runtime-config.json');
const CLUSTER_CONFIG_PATH = path.join(__dirname, 'fixtures', 'cluster.json');
const CLUSTER_CONFIG_BYTES = fs.readFileSync(CLUSTER_CONFIG_PATH, 'utf8');
const RUNTIME_CONFIG = Object.freeze(JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8')));
const RUNTIME_BUNDLE = Object.freeze({
  githubToken: 'github-test-token',
  repository: 'owner/repository',
  baseRevision: BASE_REVISION,
  delivery: {
    version: 'zeroshot.delivery/v1',
    mode: 'pr',
    repository: 'owner/repository',
    targetBranch: 'main',
    baseRevision: BASE_REVISION,
  },
  runtime: resolveHostedRuntime(RUNTIME_CONFIG, { LOCAL_MODEL_KEY: 'model-test-token' }),
});
const RUN_INTENT_ID = '019fd17e-71f3-7cf5-a57b-b8f1845c140c';
const RUN_INTENT_NOW = '2026-08-05T10:00:00.000Z';

function route(template) {
  return {
    template,
    expand(values) {
      return template.replace(/\{([^}]+)\}/g, (_match, name) =>
        encodeURIComponent(String(values[name]))
      );
    },
  };
}
const GRAPH = {
  profile: 'openengine.graph.single-worker/v1',
  root: { kind: 'step', worker: 'legacy.zeroshot.ship@1', attempts: 1 },
};
const DESCRIPTOR = {
  origin: 'https://target.example',
  oauth: {
    deviceAuthorizationEndpoint: 'https://target.example/oauth/device',
    tokenEndpoint: 'https://target.example/oauth/token',
    revocationEndpoint: 'https://target.example/oauth/revoke',
    clientId: 'private-candidate',
    deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
    audience: 'capsule',
  },
  capsule: { baseUrl: 'https://target.example/capsules/' },
  runIntent: {
    kind: 'zeroshot.run-intent/v2',
    baseUrl: 'https://target.example/api/v1',
    routes: {
      submit: route('/orgs/{org_id}/run-intents'),
      status: route('/orgs/{org_id}/run-intents/{intent_id}'),
      cancel: route('/orgs/{org_id}/run-intents/{intent_id}'),
    },
  },
  session: { routeTemplate: { template: '/sessions/{capsuleId}' } },
  sizes: { catalog: ['tiny', 'small', 'standard', 'large'], default: 'small' },
};

function runIntent(overrides = {}) {
  return {
    intent_id: RUN_INTENT_ID,
    state: 'queued',
    waiting_reason: null,
    capsule_id: null,
    result: null,
    error_code: null,
    submitted_at: RUN_INTENT_NOW,
    updated_at: RUN_INTENT_NOW,
    terminal_at: null,
    ...overrides,
  };
}

function detachedRunOptions(submissionKey, overrides = {}) {
  return {
    target: 'prod',
    graph: 'graph.json',
    input: 'input.json',
    title: 'Review checkout flow',
    submissionKey,
    detach: true,
    ...overrides,
  };
}

async function captureLogs(operation) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  try {
    const value = await operation();
    return { lines, value };
  } finally {
    console.log = original;
  }
}

function finishedWatch({ runId, cursor, onCancel }) {
  let delivered = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (delivered) return { done: true };
      delivered = true;
      return {
        done: false,
        value: {
          type: 'event',
          runId,
          cursor,
          event: {
            type: 'finished',
            final_status: {
              phase: 'finished',
              observedGeneration: 1,
              currentRunId: runId,
              atCursor: cursor,
            },
          },
        },
      };
    },
    cancel: onCancel,
  };
}

module.exports = {
  BASE_REVISION,
  captureLogs,
  CLUSTER_CONFIG_BYTES,
  CLUSTER_CONFIG_PATH,
  DESCRIPTOR,
  detachedRunOptions,
  finishedWatch,
  GRAPH,
  RUNTIME_BUNDLE,
  RUNTIME_CONFIG,
  RUNTIME_CONFIG_PATH,
  runIntent,
  RUN_INTENT_ID,
  RUN_INTENT_NOW,
};
