'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROMPT,
  SECRET,
  request,
  runScenario,
  successfulResult,
} = require('./omp-sdk-test-fixtures.cjs');

test('sidecar redacts provider failures before framing them', () => {
  const run = runScenario(request(), {
    result: successfulResult({ answer: 'unused' }),
    throwError: { status: 429, message: `rate limit ${SECRET} ${PROMPT}` },
  });

  assert.equal(run.spawned.status, 1);
  assert.deepEqual(run.frame.error, {
    code: 'provider-rate-limit',
    category: 'rate-limit',
    retryable: true,
    redacted: true,
  });
  assert.equal(run.spawned.stdout.includes(SECRET), false);
  assert.equal(run.spawned.stdout.includes(PROMPT), false);
});

test('sidecar fails closed on missing auth and resolved-model drift', () => {
  const missingAuth = runScenario(
    request(),
    { result: successfulResult({ answer: 'must not run' }) },
    { protocolVersion: 1, values: {} }
  );
  assert.equal(missingAuth.frame.error.code, 'provider-auth');
  assert.equal(missingAuth.observation.invocationCount, 0);

  const modelDrift = runScenario(request(), {
    result: successfulResult({ answer: 'unused' }, { resolvedModel: 'amazon-bedrock/other' }),
  });
  assert.equal(modelDrift.frame.error.code, 'model-resolution');
  assert.equal(modelDrift.observation.invocationCount, 1);
});
