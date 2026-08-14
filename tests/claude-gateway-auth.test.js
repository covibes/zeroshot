const assert = require('node:assert/strict');
const fs = require('node:fs');

const { getProviderMetadata } = require('../lib/provider-names');
const { checkClaudeAuth } = require('../src/preflight');

describe('Claude gateway bearer authentication', function () {
  it('accepts the documented auth-token flow with an explicitly empty Anthropic API key', function () {
    const previous = {
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
      configDir: process.env.CLAUDE_CONFIG_DIR,
    };
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent/claude-gateway-profile';
    try {
      assert.deepStrictEqual(checkClaudeAuth(), {
        authenticated: true,
        error: null,
        configDir: '/nonexistent/claude-gateway-profile',
        method: 'auth_token',
      });
    } finally {
      restore('ANTHROPIC_AUTH_TOKEN', previous.token);
      restore('ANTHROPIC_API_KEY', previous.apiKey);
      restore('CLAUDE_CONFIG_DIR', previous.configDir);
    }
  });

  it('declares the gateway credential, endpoint, and model selectors for isolation', function () {
    const metadata = getProviderMetadata('claude');
    assert.ok(metadata.credentialEnvKeys.includes('ANTHROPIC_AUTH_TOKEN'));
    for (const name of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ]) {
      assert.ok(metadata.docker.envPassthrough.includes(name), name);
    }
  });

  it('disables ambient alternate backends in the existing per-run settings overlay', function () {
    const {
      cleanupClaudeSettingsOverlay,
      prepareClaudeSettingsOverlay,
    } = require('../src/worktree-claude-config');
    const settingsPath = prepareClaudeSettingsOverlay({
      environment: {
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      },
    });
    try {
      const overlay = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const name of [
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ]) {
        assert.strictEqual(overlay.env[name], '0');
      }
    } finally {
      cleanupClaudeSettingsOverlay(settingsPath);
    }
  });
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
