const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildProviderCommand, probeRuntimeProviderCli } = require('../../lib/agent-cli-provider');
const { getProviderMetadata } = require('../../lib/provider-names');
const {
  PI_INSTALL_COMMAND,
  PI_PACKAGE_NAME,
  PI_SUPPORTED_VERSION,
} = require('../../lib/agent-cli-provider/pi/release');

const EXPECTED_CREDENTIAL_ENV = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANT_LING_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_PROFILE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_OPENAI_API_KEY',
  'BASETEN_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'NVIDIA_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'RADIUS_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
];

test('Pi release identity is one exact official package install', () => {
  assert.equal(PI_PACKAGE_NAME, '@earendil-works/pi-coding-agent');
  assert.equal(PI_SUPPORTED_VERSION, '0.84.1');
  assert.equal(
    PI_INSTALL_COMMAND,
    'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1'
  );

  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'live-provider-smoke.yml'),
    'utf8'
  );
  assert.match(
    workflow,
    new RegExp(`${PI_PACKAGE_NAME.replace('/', '\\/')}@${PI_SUPPORTED_VERSION}`)
  );
});

test('Pi registry delegates models to Pi and advertises only proven capabilities', () => {
  const pi = getProviderMetadata('pi');
  assert.equal(pi.installInstructions, PI_INSTALL_COMMAND);
  assert.equal(pi.docker.install, PI_INSTALL_COMMAND);
  assert.deepEqual(pi.credentialPaths, ['$PI_CODING_AGENT_DIR/auth.json', '~/.pi/agent/auth.json']);
  assert.deepEqual(pi.docker.configRoots, ['$HOME/.pi/agent']);
  assert.deepEqual(pi.docker.mount, {
    host: '~/.pi/agent',
    hostEnv: 'PI_CODING_AGENT_DIR',
    container: '$HOME/.pi/agent',
    readonly: false,
  });
  assert.deepEqual(pi.adapter.modelCatalog, {});
  assert.equal(pi.capabilities.reasoningEffort, true);
  assert.equal(pi.capabilities.sessionResume, false);
  assert.equal(pi.capabilities.jsonSchema, false);
  assert.equal(pi.capabilities.mcpServers, false);
});

test('Pi credential inventory matches official 0.84.1 built-ins and ambient auth', () => {
  const pi = getProviderMetadata('pi');
  assert.deepEqual([...pi.credentialEnvKeys].sort(), EXPECTED_CREDENTIAL_ENV);
  assert.equal(new Set(pi.credentialEnvKeys).size, pi.credentialEnvKeys.length);
});

test('Pi Docker auto-forwards scalar auth but requires explicit mounts for path credentials', () => {
  const env = getProviderMetadata('pi').docker.envPassthrough;
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_REGION',
    'AZURE_OPENAI_BASE_URL',
    'CLOUDFLARE_ACCOUNT_ID',
    'GOOGLE_CLOUD_PROJECT',
    'KIMI_CODE_OAUTH_HOST',
    'KIMI_OAUTH_HOST',
    'PI_CACHE_RETENTION',
  ]) {
    assert.ok(env.includes(name), `${name} should be automatic`);
  }
  for (const name of [
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    assert.equal(env.includes(name), false, `${name} should require explicit passthrough/mount`);
  }
  assert.equal(new Set(env).size, env.length);
});

test('Pi fails closed when a safety or requested thinking control is missing', () => {
  for (const [field, modelSpec] of [
    ['supportsNoApprove', undefined],
    ['supportsNoSession', undefined],
    ['supportsThinking', { reasoningEffort: 'high' }],
  ]) {
    assert.throws(
      () =>
        buildProviderCommand('pi', 'Do the task.', {
          ...(modelSpec ? { modelSpec } : {}),
          cliFeatures: { versionMatches: true, [field]: false },
        }),
      (error) => error.field === `options.cliFeatures.${field}`
    );
  }
});

test('Pi keeps option-shaped and file-shaped context in the prompt argument', () => {
  for (const context of ['-short option', '--long option', '@project-file']) {
    const spec = buildProviderCommand('pi', context, {
      cliFeatures: {
        versionMatches: true,
        supportsJsonMode: true,
        supportsNoSession: true,
        supportsNoSkills: true,
        supportsNoPromptTemplates: true,
        supportsNoContextFiles: true,
        supportsNoApprove: true,
      },
    });
    assert.equal(spec.args.at(-1), ` ${context}`);
  }
});

test('Pi rejects the previously shipped version even when its help advertises every flag', () => {
  const adapter = getProviderMetadata('pi').adapter;
  const help =
    'pi --mode json --model --thinking --no-session --no-extensions --no-skills ' +
    '--no-prompt-templates --no-context-files --no-approve';
  const features = adapter.detectCliFeatures(help, '0.80.3');
  const probe = probeRuntimeProviderCli(
    'pi',
    { available: true, helpText: help, versionText: '0.80.3' },
    {}
  );

  assert.equal(features.versionMatches, false);
  assert.equal(features.supportsJsonMode, false);
  assert.equal(probe.available, false);
  assert.throws(
    () => buildProviderCommand('pi', 'Do the task.', { cliFeatures: features }),
    (error) => error.field === 'options.cliFeatures.versionMatches'
  );
});
