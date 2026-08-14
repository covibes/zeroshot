'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const {
  childEnvironment,
} = require('../../lib/agent-cli-provider/omp/sdk-process-private-runtime');
const {
  JSON_SCHEMA,
  PROMPT,
  removePreparedRoot,
  sdkSettings,
  withSettings,
} = require('./omp-sdk-test-fixtures.cjs');

const AZURE_MODEL = 'azure/gpt-5.1';
const AZURE_CREDENTIAL = 'AZURE_OPENAI_API_KEY';

function azureSettings() {
  const level = { model: AZURE_MODEL, reasoningEffort: 'high' };
  return sdkSettings({
    levelOverrides: { level1: level, level2: level, level3: level },
    auth: {
      mode: 'environment',
      credentials: { azure: { env: AZURE_CREDENTIAL } },
    },
  });
}

function prepare() {
  return helper.prepareSingleAgentProviderCommand({
    provider: 'omp',
    context: PROMPT,
    options: {
      cwd: process.cwd(),
      executionContext: 'host',
      outputFormat: 'json',
      jsonSchema: JSON_SCHEMA,
      strictSchema: true,
      modelSpec: {
        level: 'level2',
        model: AZURE_MODEL,
        reasoningEffort: 'high',
      },
    },
  });
}

function withEnvironment(values, callback) {
  const prior = new Map();
  for (const [name, value] of Object.entries(values)) {
    prior.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('OMP SDK forwards Azure routing configuration without exposing credentials or ambient env', () => {
  withEnvironment(
    {
      AZURE_OPENAI_API_KEY: 'must-not-enter-policy',
      AZURE_OPENAI_API_VERSION: 'v1',
      AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com/openai/v1',
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{"gpt-5.1":"deployment"}',
      ZEROSHOT_UNRELATED_AMBIENT: 'must-not-enter-policy',
    },
    () =>
      withSettings(azureSettings(), () => {
        let prepared;
        try {
          prepared = prepare();
          assert.deepEqual(
            {
              AZURE_OPENAI_API_VERSION: prepared.environmentPolicy.values.AZURE_OPENAI_API_VERSION,
              AZURE_OPENAI_BASE_URL: prepared.environmentPolicy.values.AZURE_OPENAI_BASE_URL,
              AZURE_OPENAI_DEPLOYMENT_NAME_MAP:
                prepared.environmentPolicy.values.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
            },
            {
              AZURE_OPENAI_API_VERSION: 'v1',
              AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com/openai/v1',
              AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{"gpt-5.1":"deployment"}',
            }
          );
          assert.equal(prepared.environmentPolicy.values.AZURE_OPENAI_API_KEY, undefined);
          assert.equal(prepared.environmentPolicy.values.ZEROSHOT_UNRELATED_AMBIENT, undefined);
          assert.deepEqual(prepared.credentialNames, [AZURE_CREDENTIAL]);
        } finally {
          removePreparedRoot(prepared);
        }
      })
  );
});

test('OMP SDK child environment accepts declared routing config and rejects undeclared values', () => {
  const runtime = {
    root: '/tmp/zeroshot-omp-sdk-test',
    requestPath: '/tmp/zeroshot-omp-sdk-test/request.json',
    home: '/tmp/zeroshot-omp-sdk-test/home',
    xdgConfig: '/tmp/zeroshot-omp-sdk-test/xdg-config',
    xdgCache: '/tmp/zeroshot-omp-sdk-test/xdg-cache',
    xdgData: '/tmp/zeroshot-omp-sdk-test/xdg-data',
    xdgState: '/tmp/zeroshot-omp-sdk-test/xdg-state',
    piDirectory: '/tmp/zeroshot-omp-sdk-test/pi',
  };
  const environment = childEnvironment(
    {
      inherit: 'minimal',
      values: {
        AZURE_OPENAI_API_VERSION: 'v1',
        AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com/openai/v1',
      },
    },
    runtime
  );
  assert.equal(environment.AZURE_OPENAI_API_VERSION, 'v1');
  assert.equal(environment.AZURE_OPENAI_BASE_URL, 'https://example.openai.azure.com/openai/v1');
  assert.equal(environment.HOME, runtime.home);

  assert.throws(
    () =>
      childEnvironment(
        { inherit: 'minimal', values: { ZEROSHOT_UNRELATED_AMBIENT: 'blocked' } },
        runtime
      ),
    /unsupported key ZEROSHOT_UNRELATED_AMBIENT/
  );
  assert.throws(
    () =>
      childEnvironment(
        { inherit: 'minimal', values: { AZURE_OPENAI_API_KEY: 'blocked' } },
        runtime
      ),
    /unsupported key AZURE_OPENAI_API_KEY/
  );
});
