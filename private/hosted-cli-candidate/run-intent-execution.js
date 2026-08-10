'use strict';

const { validateLegacyShipRequest } = require('../../lib/cluster-worker/contracts');

const HOSTED_INPUT_KEYS = new Set(['artifacts', 'issue', 'prompt', 'source']);
const ISOLATION_PROFILE = 'isolation.prepared-worktree@1';
const MODEL_LEVEL = 'level1';
const PROVIDER_PROFILE = 'provider.hosted-direct@1';

function buildHostedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('hosted input must be a LegacyShipRequest object');
  }
  const unsupported = Object.keys(input).find((key) => !HOSTED_INPUT_KEYS.has(key));
  if (unsupported !== undefined) {
    throw new Error(`hosted input contains unsupported field ${unsupported}`);
  }
  if (input.source === 'artifact') {
    throw new Error('hosted artifact input is unavailable without trusted artifact staging');
  }
  validateLegacyShipRequest({
    ...input,
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    repository: 'runtime-owned/repository',
    provider: 'runtime-owned',
    modelLevel: MODEL_LEVEL,
  });
  return Object.freeze({ ...input });
}

function buildRunIntentExecution(inputs) {
  return Object.freeze({
    graph: inputs.graph,
    input: buildHostedInput(inputs.input),
  });
}

module.exports = { buildHostedInput, buildRunIntentExecution };
