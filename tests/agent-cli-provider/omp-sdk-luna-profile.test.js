'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const {
  JSON_SCHEMA,
  MODEL,
  PROMPT,
  removePreparedRoot,
  sdkSettings,
  withSettings,
} = require('./omp-sdk-test-fixtures.cjs');

function prepare(modelSpec) {
  return helper.prepareSingleAgentProviderCommand({
    provider: 'omp',
    context: PROMPT,
    options: {
      cwd: process.cwd(),
      executionContext: 'host',
      outputFormat: 'json',
      jsonSchema: JSON_SCHEMA,
      strictSchema: true,
      modelSpec,
    },
  });
}

test('omitted transport locks all levels to Luna max through SDK 17.2.1 and Bun 1.3.14', () => {
  withSettings(sdkSettings(), () => {
    for (const level of ['level1', 'level2', 'level3']) {
      let prepared;
      try {
        prepared = prepare({ level, model: MODEL, reasoningEffort: 'max' });
        const request = JSON.parse(readFileSync(prepared.privateArtifacts.requestPath, 'utf8'));
        assert.deepEqual(prepared.invoke, {
          lane: 'spawn',
          parser: 'omp-sdk-ndjson',
          ptyEligible: false,
          strictTerminal: true,
        });
        assert.deepEqual(prepared.executionIdentity, {
          backend: 'omp-sdk',
          backendVersion: '17.2.1',
          runtime: { name: 'bun', version: '1.3.14' },
          transport: 'sdk',
        });
        assert.deepEqual(prepared.semanticIdentity, {
          requestedModelSelector: MODEL,
          reasoningEffort: 'max',
          provider: 'amazon-bedrock',
        });
        assert.equal(request.modelSelector, MODEL);
        assert.equal(request.reasoningEffort, 'max');
        assert.equal(request.outputMode, 'json');
        assert.deepEqual(request.outputSchema, JSON_SCHEMA);
      } finally {
        removePreparedRoot(prepared);
      }
    }
  });
});

test('OMP SDK rejects model or effort that differs from the selected level override', () => {
  withSettings(sdkSettings(), () => {
    assert.throws(
      () => prepare({ level: 'level2', model: 'amazon-bedrock/other-model' }),
      /model must exactly match providerSettings\.omp\.levelOverrides\.level2\.model/
    );
    assert.throws(
      () => prepare({ level: 'level2', model: MODEL, reasoningEffort: 'high' }),
      /reasoningEffort must exactly match providerSettings\.omp\.levelOverrides\.level2\.reasoningEffort/
    );
  });
});
