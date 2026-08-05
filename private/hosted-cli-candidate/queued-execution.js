'use strict';

const { validateLegacyShipRequest } = require('../../lib/cluster-worker/contracts');
const { assertHostedSelection, ISOLATION_PROFILE, PROVIDER_PROFILE } = require('./orchestrator');

const QUEUED_INPUT_KEYS = new Set(['artifacts', 'issue', 'prompt', 'source']);

function buildQueuedShipInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('hosted input must be an object');
  }
  const unsupported = Object.keys(input).find((key) => !QUEUED_INPUT_KEYS.has(key));
  if (unsupported !== undefined) {
    throw new Error(`queued hosted input contains unsupported field ${unsupported}`);
  }
  if (input.source === 'artifact') {
    throw new Error('hosted artifact input is unavailable without trusted artifact staging');
  }
  validateLegacyShipRequest({
    ...input,
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    repository: 'server-owned/repository',
    provider: 'server-owned',
    modelLevel: 'level1',
  });
  return Object.freeze({ ...input });
}

function buildQueuedHostedExecution(inputs, setup, expected) {
  assertHostedSelection(setup, expected);
  return Object.freeze({
    graph: inputs.graph,
    input: buildQueuedShipInput(inputs.input),
  });
}

module.exports = { buildQueuedHostedExecution, buildQueuedShipInput };
