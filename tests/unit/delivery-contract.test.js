'use strict';

const assert = require('node:assert/strict');
const {
  DELIVERY_CONTRACT_VERSION,
  normalizeDeliveryRequest,
  normalizeDeliveryResult,
} = require('../../lib/delivery-contract');

const request = Object.freeze({
  version: DELIVERY_CONTRACT_VERSION,
  mode: 'pr',
  repository: 'the-open-engine/hosted-runtime-canary',
  targetBranch: 'main',
  baseRevision: 'a'.repeat(40),
});

describe('delivery contract', () => {
  it('accepts one closed immutable request shape', () => {
    const normalized = normalizeDeliveryRequest(request);
    assert.deepEqual(normalized, request);
    assert.equal(Object.isFrozen(normalized), true);
    assert.throws(() => normalizeDeliveryRequest({ ...request, policy: 'caller-owned' }));
  });

  it('keeps pr and ship success dispositions distinct', () => {
    const common = {
      ...request,
      deliveryBranch: 'zeroshot/hosted-abc',
      headRevision: 'b'.repeat(40),
      pullRequestUrl: 'https://github.com/the-open-engine/hosted-runtime-canary/pull/1',
    };
    assert.equal(
      normalizeDeliveryResult({ ...common, disposition: 'pull_request_open' }).disposition,
      'pull_request_open'
    );
    assert.throws(() =>
      normalizeDeliveryResult({ ...common, mode: 'ship', disposition: 'pull_request_open' })
    );
    assert.equal(
      normalizeDeliveryResult({
        ...common,
        mode: 'ship',
        disposition: 'merged',
        mergeRevision: 'c'.repeat(40),
      }).disposition,
      'merged'
    );
    assert.equal(
      normalizeDeliveryResult({
        ...common,
        mode: 'ship',
        disposition: 'auto_merge_enabled',
      }).disposition,
      'auto_merge_enabled'
    );
  });
});
