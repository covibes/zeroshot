'use strict';

const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
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
  session: { routeTemplate: { template: '/sessions/{capsuleId}' } },
  sizes: { catalog: ['tiny', 'small', 'standard', 'large'], default: 'small' },
};

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

module.exports = { captureLogs, DESCRIPTOR, finishedWatch, GRAPH, RUNTIME_DIGEST };
