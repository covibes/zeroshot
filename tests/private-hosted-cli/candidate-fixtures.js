'use strict';

const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_REVISION = 'b'.repeat(40);
const RUNTIME_CONFIG = Object.freeze({
  provider: 'claude',
  executable: 'claude',
  model: 'claude-sonnet-4-5',
  environment: { ANTHROPIC_API_KEY: { from: 'LOCAL_MODEL_KEY' } },
  files: {},
  settings: { defaultProvider: 'claude' },
});
const RUNTIME_BUNDLE = Object.freeze({
  githubToken: 'github-test-token',
  repository: 'owner/repository',
  baseRevision: BASE_REVISION,
  runtime: {
    ...RUNTIME_CONFIG,
    environment: { ANTHROPIC_API_KEY: 'model-test-token' },
  },
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
  credentialInstall: {
    kind: 'openengine.capsule-credential-install/v1',
    install: {
      routeTemplate: route('/capsules/{capsule_id}/credentials'),
      method: 'PUT',
    },
    maxBodyBytes: 4 * 1024 * 1024,
  },
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
  DESCRIPTOR,
  finishedWatch,
  GRAPH,
  RUNTIME_BUNDLE,
  RUNTIME_CONFIG,
  runIntent,
  RUN_INTENT_ID,
  RUN_INTENT_NOW,
  RUNTIME_DIGEST,
};
