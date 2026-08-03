const assert = require('node:assert/strict');
const { test } = require('node:test');

const settingsApi = require('../../lib/agent-cli-provider/omp-sdk-settings');
const helper = require('../../lib/agent-cli-provider');

const {
  OMP_AUTH_BROKER_ENV_NAMES,
  OMP_SDK_SETTINGS_DEFAULTS,
  OMP_SDK_TOOL_IDS,
  compilePrivateOmpModelsYaml,
  normalizeOmpSdkSettings,
  resolveOmpSdkSettings,
  validateOmpSdkSettings,
} = settingsApi;

function withSelector(settings, selector) {
  return {
    ...settings,
    levelOverrides: Object.fromEntries(
      ['level1', 'level2', 'level3'].map((level) => [
        level,
        { model: selector, reasoningEffort: 'max' },
      ])
    ),
  };
}

function expectInvalid(settings, pattern, context) {
  assert.throws(() => normalizeOmpSdkSettings(settings, context), pattern);
  assert.match(validateOmpSdkSettings(settings, context), pattern);
}

test('OMP defaults configure only the SDK backend and closed tool policy', () => {
  const normalized = normalizeOmpSdkSettings(OMP_SDK_SETTINGS_DEFAULTS);

  assert.equal(normalized.transport, 'sdk');
  assert.deepEqual(normalized.tools, [
    'read',
    'bash',
    'edit',
    'write',
    'grep',
    'glob',
    'lsp',
    'ast_edit',
  ]);
  assert.deepEqual(normalized.tools, OMP_SDK_TOOL_IDS);
  assert.equal(normalized.nestedAgents, false);
  assert.equal(normalized.mcp, false);
  assert.deepEqual(normalized.levelOverrides, {});
  assert.equal(normalized.auth, undefined);
  assert.equal(validateOmpSdkSettings(OMP_SDK_SETTINGS_DEFAULTS), null);
  expectInvalid(
    OMP_SDK_SETTINGS_DEFAULTS,
    /requires explicit full provider\/model selectors for every level/i,
    { executionContext: 'host', requireModelConfiguration: true }
  );
});

test('client and runtime resolve the same providerSettings.omp object', () => {
  const configured = withSelector(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      auth: {
        mode: 'environment',
        credentials: { 'amazon-bedrock': { env: 'AWS_BEARER_TOKEN_BEDROCK' } },
      },
    },
    'amazon-bedrock/openai.gpt-5.6-sol'
  );
  const resolved = resolveOmpSdkSettings(
    { providerSettings: { omp: configured } },
    { executionContext: 'host', requireModelConfiguration: true }
  );

  assert.deepEqual(
    resolved,
    normalizeOmpSdkSettings(configured, {
      executionContext: 'host',
      requireModelConfiguration: true,
    })
  );
  assert.throws(
    () => resolveOmpSdkSettings({ providerSettings: [] }),
    /providerSettings must be an object/i
  );
});

test('OMP registry exposes SDK settings but does not claim RPC structured-output capability', () => {
  const metadata = helper.getProviderRegistryEntry('omp');

  assert.deepEqual(metadata.settingsDefaults, OMP_SDK_SETTINGS_DEFAULTS);
  assert.equal(metadata.settingsValidator(OMP_SDK_SETTINGS_DEFAULTS), null);
  assert.equal(metadata.capabilities.jsonSchema, false);
  assert.equal(
    normalizeOmpSdkSettings({ ...OMP_SDK_SETTINGS_DEFAULTS, transport: 'rpc' }).transport,
    'rpc'
  );
  assert.match(metadata.authInstructions, /Manually edit providerSettings\.omp/);
  assert.doesNotMatch(metadata.authInstructions, /login/i);
});

test('built-in Bedrock compiles an empty providers-only models file', () => {
  const compiled = compilePrivateOmpModelsYaml(OMP_SDK_SETTINGS_DEFAULTS);

  assert.deepEqual(JSON.parse(compiled), { providers: {} });
  assert.doesNotMatch(compiled, /AWS_BEARER_TOKEN/);
});

test('custom OpenAI-compatible provider compiles only native providers and env references', () => {
  const custom = normalizeOmpSdkSettings(
    withSelector(
      {
        ...OMP_SDK_SETTINGS_DEFAULTS,
        auth: {
          mode: 'environment',
          credentials: { fixture: { env: 'FIXTURE_OPENAI_API_KEY' } },
        },
        modelsConfig: {
          providers: {
            fixture: {
              baseUrl: 'http://127.0.0.1:4319/v1',
              api: 'openai-completions',
              models: [
                {
                  id: 'fixture-model',
                  name: 'Fixture model',
                  reasoning: true,
                  input: ['text'],
                  supportsTools: true,
                  contextWindow: 32768,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      'fixture/fixture-model'
    )
  );

  const compiled = JSON.parse(compilePrivateOmpModelsYaml(custom));
  assert.deepEqual(Object.keys(compiled), ['providers']);
  assert.equal(compiled.providers.fixture.apiKey, 'FIXTURE_OPENAI_API_KEY');
  assert.equal(compiled.providers.fixture.models[0].id, 'fixture-model');
  assert.doesNotMatch(JSON.stringify(compiled), /secret|token-value/i);
});

test('environment auth fails closed for malformed and missing references', () => {
  expectInvalid(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      auth: { mode: 'environment', credentials: {} },
    },
    /requires at least one provider credential reference/i
  );
  expectInvalid(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      auth: {
        mode: 'environment',
        credentials: { 'amazon-bedrock': { env: 'literal secret' } },
      },
    },
    /environment variable name/i
  );
  expectInvalid(
    withSelector(
      {
        ...OMP_SDK_SETTINGS_DEFAULTS,
        auth: { mode: 'environment', credentials: { openai: { env: 'OPENAI_API_KEY' } } },
      },
      'amazon-bedrock/openai.gpt-5.6-sol'
    ),
    /missing a credential reference/i
  );
});

test('unknown, equivalence, literal-secret, command, header, and URL-userinfo fields are rejected', () => {
  expectInvalid({ ...OMP_SDK_SETTINGS_DEFAULTS, typo: true }, /Unknown OMP setting/);
  expectInvalid(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      modelsConfig: { providers: {}, equivalence: {} },
    },
    /equivalence/
  );

  for (const apiKey of ['sk-literal-secret', '!security find-generic-password']) {
    expectInvalid(
      {
        ...OMP_SDK_SETTINGS_DEFAULTS,
        modelsConfig: {
          providers: {
            'amazon-bedrock': { apiKey },
          },
        },
      },
      /apiKey must be an environment variable name/i
    );
  }

  expectInvalid(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      modelsConfig: {
        providers: {
          'amazon-bedrock': { headers: { Authorization: 'Bearer literal-secret' } },
        },
      },
    },
    /headers may persist credentials/i
  );
  expectInvalid(
    {
      ...OMP_SDK_SETTINGS_DEFAULTS,
      modelsConfig: {
        providers: {
          'amazon-bedrock': { baseUrl: 'https://user:secret@example.test/v1' },
        },
      },
    },
    /URL userinfo/i
  );
});

test('keyless and fixed-name broker auth are accepted without secret values', () => {
  const keyless = normalizeOmpSdkSettings(
    withSelector(
      {
        ...OMP_SDK_SETTINGS_DEFAULTS,
        auth: { mode: 'none' },
        modelsConfig: {
          providers: {
            local: {
              baseUrl: 'http://localhost:11434/v1',
              api: 'openai-completions',
              auth: 'none',
              models: [{ id: 'fixture' }],
            },
          },
        },
      },
      'local/fixture'
    )
  );
  assert.deepEqual(keyless.auth, { mode: 'none' });
  assert.equal(JSON.parse(compilePrivateOmpModelsYaml(keyless)).providers.local.auth, 'none');

  const broker = normalizeOmpSdkSettings({
    ...OMP_SDK_SETTINGS_DEFAULTS,
    auth: { mode: 'broker' },
  });
  assert.deepEqual(broker.auth, { mode: 'broker' });
  assert.deepEqual(OMP_AUTH_BROKER_ENV_NAMES, {
    url: 'OMP_AUTH_BROKER_URL',
    token: 'OMP_AUTH_BROKER_TOKEN',
  });
  expectInvalid(
    { ...OMP_SDK_SETTINGS_DEFAULTS, auth: { mode: 'broker', token: 'literal-secret' } },
    /Unknown OMP setting/
  );
});

test('omp-home is explicit absolute-path host-only auth', () => {
  const local = normalizeOmpSdkSettings(
    { ...OMP_SDK_SETTINGS_DEFAULTS, auth: { mode: 'omp-home', path: '/home/test/.omp' } },
    { executionContext: 'host' }
  );
  assert.deepEqual(local.auth, { mode: 'omp-home', path: '/home/test/.omp' });

  expectInvalid(
    { ...OMP_SDK_SETTINGS_DEFAULTS, auth: { mode: 'omp-home', path: '.omp' } },
    /absolute local path/i,
    { executionContext: 'host' }
  );
  for (const executionContext of ['detached', 'docker']) {
    expectInvalid(
      {
        ...OMP_SDK_SETTINGS_DEFAULTS,
        auth: { mode: 'omp-home', path: '/home/test/.omp' },
      },
      /local host-only/i,
      { executionContext }
    );
  }
});

test('selectors, bounds, effort, tools, and disabled ambient features fail closed', () => {
  expectInvalid(
    withSelector(OMP_SDK_SETTINGS_DEFAULTS, 'openai.gpt-5.6-sol'),
    /full provider\/model selector/i
  );
  expectInvalid(
    { ...OMP_SDK_SETTINGS_DEFAULTS, minLevel: 'level3', defaultLevel: 'level2' },
    /minLevel <= defaultLevel <= maxLevel/i
  );
  for (const reasoningEffort of ['auto', 'minimal']) {
    expectInvalid(
      {
        ...withSelector(OMP_SDK_SETTINGS_DEFAULTS, 'amazon-bedrock/openai.gpt-5.6-sol'),
        levelOverrides: {
          ...withSelector(OMP_SDK_SETTINGS_DEFAULTS, 'amazon-bedrock/openai.gpt-5.6-sol')
            .levelOverrides,
          level2: { model: 'amazon-bedrock/openai.gpt-5.6-sol', reasoningEffort },
        },
      },
      /reasoningEffort must be one of/i
    );
  }
  expectInvalid(
    { ...OMP_SDK_SETTINGS_DEFAULTS, tools: [...OMP_SDK_TOOL_IDS, 'eval'] },
    /restricted to/
  );
  expectInvalid({ ...OMP_SDK_SETTINGS_DEFAULTS, nestedAgents: true }, /must be false/);
  expectInvalid({ ...OMP_SDK_SETTINGS_DEFAULTS, mcp: true }, /must be false/);
});
