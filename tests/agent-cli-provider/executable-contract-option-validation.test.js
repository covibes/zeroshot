const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  runExecutable,
  runProviderExecutable,
  runnerResult,
} = require('./executable-contract-helpers.cjs');

const invalidNestedOptionCases = [
  {
    name: 'cwd type',
    options: { cwd: 123, cliFeatures: { supportsCwd: true } },
    field: 'options.cwd',
  },
  { name: 'outputFormat enum', options: { outputFormat: 'xml' }, field: 'options.outputFormat' },
  { name: 'autoApprove type', options: { autoApprove: 'yes' }, field: 'options.autoApprove' },
  {
    name: 'resumeSessionId type',
    options: { resumeSessionId: 123 },
    field: 'options.resumeSessionId',
  },
  {
    name: 'continueSession type',
    options: { continueSession: 'yes' },
    field: 'options.continueSession',
  },
  { name: 'strictSchema type', options: { strictSchema: 'yes' }, field: 'options.strictSchema' },
  {
    name: 'cliFeatures boolean',
    options: { cliFeatures: { supportsCwd: 'true' } },
    field: 'options.cliFeatures.supportsCwd',
  },
  {
    name: 'cliFeatures supportsDir boolean',
    options: { cliFeatures: { supportsDir: 'true' } },
    field: 'options.cliFeatures.supportsDir',
  },
  { name: 'modelSpec object', options: { modelSpec: 'level2' }, field: 'options.modelSpec' },
  {
    name: 'modelSpec level enum',
    options: { modelSpec: { level: 'level4' } },
    field: 'options.modelSpec.level',
  },
  {
    name: 'modelSpec model type',
    options: { modelSpec: { model: 123 } },
    field: 'options.modelSpec.model',
  },
  {
    name: 'modelSpec reasoningEffort enum',
    options: { modelSpec: { reasoningEffort: 'extreme' } },
    field: 'options.modelSpec.reasoningEffort',
  },
  {
    name: 'mcpConfig array',
    options: { mcpConfig: '{"mcpServers":{}}' },
    field: 'options.mcpConfig',
  },
  {
    name: 'mcpConfig entry type',
    options: { mcpConfig: [123] },
    field: 'options.mcpConfig[0]',
  },
  {
    name: 'mcpConfig entry empty',
    options: { mcpConfig: ['   '] },
    field: 'options.mcpConfig[0]',
  },
  {
    name: 'gateway object',
    options: { gateway: 'http://localhost:11434' },
    field: 'options.gateway',
  },
  {
    name: 'gateway headers string values',
    options: { gateway: { headers: { Authorization: 123 } } },
    field: 'options.gateway.headers.Authorization',
  },
  {
    name: 'gateway protocol enum',
    options: { gateway: { protocol: 'messages' } },
    field: 'options.gateway.protocol',
  },
  {
    name: 'gateway max tokens positive integer',
    options: { gateway: { maxTokens: 0 } },
    field: 'options.gateway.maxTokens',
  },
  {
    name: 'gateway tool policy object',
    options: { gateway: { toolPolicy: 'all-access' } },
    field: 'options.gateway.toolPolicy',
  },
  {
    name: 'gateway tool policy roots array',
    options: { gateway: { toolPolicy: { roots: 'src', commands: [] } } },
    field: 'options.gateway.toolPolicy.roots',
  },
  {
    name: 'gateway tool policy command timeout',
    options: { gateway: { toolPolicy: { roots: ['src'], commands: [], commandTimeoutMs: 0 } } },
    field: 'options.gateway.toolPolicy.commandTimeoutMs',
  },
];

test('build-command rejects invalid nested options before command spec creation', () => {
  for (const { name, options, field } of invalidNestedOptionCases) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'build-command',
      provider: 'codex',
      context: 'hi',
      options,
    });

    assert.equal(response.exitCode, 2, name);
    assert.equal(response.envelope.ok, false, name);
    assert.equal(response.envelope.error.code, 'invalid-field', name);
    assert.equal(response.envelope.error.field, field, name);
  }
});

test('invoke rejects invalid nested options before runner execution', async () => {
  for (const { name, options, field } of invalidNestedOptionCases) {
    let runnerCalled = false;
    const response = await runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'codex',
        context: 'hi',
        options,
      },
      {
        runner: () => {
          runnerCalled = true;
          return runnerResult();
        },
      }
    );

    assert.equal(response.exitCode, 2, name);
    assert.equal(response.envelope.ok, false, name);
    assert.equal(response.envelope.error.code, 'invalid-field', name);
    assert.equal(response.envelope.error.field, field, name);
    assert.equal(runnerCalled, false, name);
  }
});
