'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL,
  assertSafeSingleInvocation,
  request,
  runScenario,
  successfulResult,
} = require('./omp-sdk-test-fixtures.cjs');

function assertSchemaFailure(run) {
  assert.equal(run.spawned.status, 1);
  assert.equal(run.frame.type, 'error');
  assert.equal(run.frame.error.code, 'schema-violation');
  assertSafeSingleInvocation(assert, run);
}

test('one successful terminal yield emits exact caller strict evidence', () => {
  const value = { answer: 'validated after in-session schema feedback' };
  const run = runScenario(request(), { result: successfulResult(value) });

  assert.equal(run.spawned.status, 0);
  assert.equal(run.frame.type, 'result');
  assert.deepEqual(run.frame.value, value);
  assert.deepEqual(run.frame.backend, { id: 'omp-sdk', version: '17.2.1' });
  assert.deepEqual(run.frame.runtime, { name: 'bun', version: '1.3.14' });
  assert.deepEqual(run.frame.requested, {
    modelSelector: MODEL,
    reasoningEffort: 'max',
    outputMode: 'json',
  });
  assert.deepEqual(run.frame.resolved, { modelSelector: MODEL });
  assert.deepEqual(run.frame.strictOutput, {
    source: 'caller',
    mode: 'strict',
    status: 'valid',
    yieldCount: 1,
  });
  assert.equal(run.frame.fallback, false);
  assert.equal(run.frame.usage.requests, 2);
  assertSafeSingleInvocation(assert, run);
});

test('missing, duplicate, incremental, and schema-invalid yields fail closed', () => {
  const valid = { answer: 'one' };
  const scenarios = [
    successfulResult(valid, { extractedToolData: {} }),
    successfulResult(valid, {
      extractedToolData: {
        yield: [
          { status: 'success', data: valid },
          { status: 'success', data: valid, type: 'final' },
        ],
      },
    }),
    successfulResult(valid, {
      extractedToolData: { yield: [{ status: 'success', data: valid, type: ['answer'] }] },
    }),
    successfulResult({ answer: 42 }),
  ];

  for (const result of scenarios) {
    assertSchemaFailure(runScenario(request(), { result }));
  }
});

test('exhausted malformed yield remains one failed SDK invocation', () => {
  const value = { answer: 42 };
  const result = successfulResult(value, {
    exitCode: 1,
    structuredOutput: { source: 'caller', mode: 'strict', status: 'invalid', data: value },
    extractedToolData: {
      yield: [{ status: 'success', data: value, schemaOverridden: true }],
    },
    error: 'schema_violation',
  });

  assertSchemaFailure(runScenario(request(), { result }));
});
