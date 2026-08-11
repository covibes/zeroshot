/**
 * Claude authentication settings and helpers
 * Extracted from settings.js for provider-specific isolation
 */

import providerNames = require('../provider-names');

interface ClaudeProviderSettings {
  readonly anthropicApiKey?: string;
  readonly bedrockApiKey?: string;
  readonly bedrockRegion?: string;
}

interface Settings {
  readonly providerSettings?: {
    readonly claude?: ClaudeProviderSettings;
  };
}

/**
 * Anthropic API key prefix for validation
 */
const ANTHROPIC_KEY_PREFIX = 'sk-ant-';

/**
 * Environment variables used for Claude authentication
 */
const CLAUDE_AUTH_ENV_VARS = [
  ...providerNames.getProviderMetadata('claude').docker.envPassthrough,
];

/**
 * Validate an Anthropic API key format
 */
function isValidAnthropicKey(key: string | null | undefined): boolean {
  return !key || key.startsWith(ANTHROPIC_KEY_PREFIX);
}

/**
 * Check if Bedrock mode is active based on env and overrides
 */
function isBedrockMode(envOverrides: NodeJS.ProcessEnv = {}): boolean {
  return (
    envOverrides.CLAUDE_CODE_USE_BEDROCK === '1' || process.env.CLAUDE_CODE_USE_BEDROCK === '1'
  );
}

/**
 * Resolve Claude authentication environment variables from settings.
 * Bedrock takes priority over direct Anthropic API key and OAuth sessions.
 */
function resolveClaudeAuth(settings: Settings): NodeJS.ProcessEnv {
  const claudeSettings = settings.providerSettings?.claude || {};
  const env: NodeJS.ProcessEnv = {};

  if (!process.env.AWS_BEARER_TOKEN_BEDROCK && claudeSettings.bedrockApiKey) {
    env.AWS_BEARER_TOKEN_BEDROCK = claudeSettings.bedrockApiKey;
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (claudeSettings.bedrockRegion && !process.env.AWS_REGION) {
      env.AWS_REGION = claudeSettings.bedrockRegion;
    }
  } else if (process.env.AWS_BEARER_TOKEN_BEDROCK && !process.env.CLAUDE_CODE_USE_BEDROCK) {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
  }

  const hasBedrock = env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!process.env.ANTHROPIC_API_KEY && !hasBedrock && claudeSettings.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = claudeSettings.anthropicApiKey;
  }

  return env;
}

export = {
  ANTHROPIC_KEY_PREFIX,
  CLAUDE_AUTH_ENV_VARS,
  isValidAnthropicKey,
  isBedrockMode,
  resolveClaudeAuth,
};
