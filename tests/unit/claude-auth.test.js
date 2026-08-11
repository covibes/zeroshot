const assert = require('node:assert/strict');

const claudeAuth = require('../../lib/settings/claude-auth');
const { getProviderMetadata } = require('../../lib/provider-names');

const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'CLAUDE_CODE_USE_BEDROCK',
];

function withCleanAuthEnv(run) {
  const original = Object.fromEntries(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of AUTH_ENV_KEYS) delete process.env[key];

  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Claude authentication settings', () => {
  it('preserves the CommonJS API contract', () => {
    assert.deepStrictEqual(Reflect.ownKeys(claudeAuth), [
      'ANTHROPIC_KEY_PREFIX',
      'CLAUDE_AUTH_ENV_VARS',
      'isValidAnthropicKey',
      'isBedrockMode',
      'resolveClaudeAuth',
    ]);
    assert.deepStrictEqual(
      Object.values(claudeAuth)
        .filter((value) => typeof value === 'function')
        .map((value) => value.length),
      [1, 0, 1]
    );
  });

  it('copies the registry-owned Claude environment list', () => {
    const registryList = getProviderMetadata('claude').docker.envPassthrough;
    assert.deepStrictEqual(claudeAuth.CLAUDE_AUTH_ENV_VARS, registryList);
    assert.notStrictEqual(claudeAuth.CLAUDE_AUTH_ENV_VARS, registryList);
  });

  it('validates only non-empty Anthropic key prefixes', () => {
    assert.strictEqual(claudeAuth.isValidAnthropicKey(undefined), true);
    assert.strictEqual(claudeAuth.isValidAnthropicKey(null), true);
    assert.strictEqual(claudeAuth.isValidAnthropicKey(''), true);
    assert.strictEqual(claudeAuth.isValidAnthropicKey('sk-ant-example'), true);
    assert.strictEqual(claudeAuth.isValidAnthropicKey('invalid'), false);
  });

  it('detects Bedrock mode from overrides or the process environment', () => {
    withCleanAuthEnv(() => {
      assert.strictEqual(claudeAuth.isBedrockMode(), false);
      assert.strictEqual(claudeAuth.isBedrockMode({ CLAUDE_CODE_USE_BEDROCK: '1' }), true);
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      assert.strictEqual(claudeAuth.isBedrockMode(), true);
    });
  });
});

describe('Claude authentication resolution', () => {
  it('resolves configured Bedrock credentials before Anthropic credentials', () => {
    withCleanAuthEnv(() => {
      assert.deepStrictEqual(
        claudeAuth.resolveClaudeAuth({
          providerSettings: {
            claude: {
              anthropicApiKey: 'sk-ant-direct',
              bedrockApiKey: 'bedrock-token',
              bedrockRegion: 'us-east-1',
            },
          },
        }),
        {
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: 'us-east-1',
        }
      );
    });
  });

  it('honors environment credentials and only fills missing auth values', () => {
    withCleanAuthEnv(() => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'environment-token';
      process.env.AWS_REGION = 'environment-region';

      assert.deepStrictEqual(
        claudeAuth.resolveClaudeAuth({
          providerSettings: {
            claude: {
              anthropicApiKey: 'sk-ant-direct',
              bedrockApiKey: 'configured-token',
              bedrockRegion: 'configured-region',
            },
          },
        }),
        { CLAUDE_CODE_USE_BEDROCK: '1' }
      );

      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-environment';
      assert.deepStrictEqual(
        claudeAuth.resolveClaudeAuth({
          providerSettings: { claude: { anthropicApiKey: 'sk-ant-configured' } },
        }),
        {}
      );
    });
  });

  it('uses configured Anthropic credentials when Bedrock is absent', () => {
    withCleanAuthEnv(() => {
      assert.deepStrictEqual(
        claudeAuth.resolveClaudeAuth({
          providerSettings: { claude: { anthropicApiKey: 'sk-ant-configured' } },
        }),
        { ANTHROPIC_API_KEY: 'sk-ant-configured' }
      );
      assert.deepStrictEqual(claudeAuth.resolveClaudeAuth({}), {});
    });
  });
});
