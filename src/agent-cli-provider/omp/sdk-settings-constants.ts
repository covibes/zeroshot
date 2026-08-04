import { OMP_SDK_REASONING_EFFORTS } from './sdk-settings-types';

export const LEVELS = ['level1', 'level2', 'level3'] as const;
export const EFFORTS = OMP_SDK_REASONING_EFFORTS;
export const APIS = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-gemini-cli',
  'google-vertex',
] as const;
export const INPUT_TYPES = ['text', 'image'] as const;
export const THINKING_MODES = [
  'effort',
  'budget',
  'google-level',
  'anthropic-adaptive',
  'anthropic-budget-effort',
] as const;
export const COMPAT_FIELDS = new Set([
  'supportsStore',
  'supportsDeveloperRole',
  'supportsMultipleSystemMessages',
  'supportsReasoningEffort',
  'reasoningEffortMap',
  'maxTokensField',
  'supportsUsageInStreaming',
  'requiresToolResultName',
  'requiresMistralToolIds',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'reasoningContentField',
  'requiresReasoningContentForToolCalls',
  'allowsSyntheticReasoningContentForToolCalls',
  'requiresAssistantContentForToolCalls',
  'supportsToolChoice',
  'supportsForcedToolChoice',
  'disableReasoningOnForcedToolChoice',
  'disableReasoningOnToolChoice',
  'thinkingFormat',
  'openRouterRouting',
  'vercelGatewayRouting',
  'cacheControlFormat',
  'supportsStrictMode',
  'toolStrictMode',
  'streamIdleTimeoutMs',
  'supportsLongPromptCacheRetention',
  'supportsReasoningParams',
  'alwaysSendMaxTokens',
  'strictResponsesPairing',
  'supportsImageDetailOriginal',
  'supportsEagerToolInputStreaming',
  'allowAnthropicHeaderOverrides',
  'requiresToolResultId',
  'replayUnsignedThinking',
  'promptCacheMode',
  'promptCacheMinimumTokens',
  'promptCacheMaximumCheckpoints',
  'whenThinking',
  'extraBody',
]);
export const COMPAT_STRING_ENUMS = {
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  reasoningContentField: ['reasoning_content', 'reasoning', 'reasoning_text'],
  thinkingFormat: ['openai', 'openrouter', 'zai', 'qwen', 'qwen-chat-template'],
  cacheControlFormat: ['anthropic'],
  toolStrictMode: ['all_strict', 'none'],
  promptCacheMode: ['none', 'automatic', 'explicit'],
} as const;
export const COMPAT_NUMBER_FIELDS = new Set([
  'streamIdleTimeoutMs',
  'promptCacheMinimumTokens',
  'promptCacheMaximumCheckpoints',
]);
export const COMPAT_RECORD_FIELDS = new Set([
  'reasoningEffortMap',
  'openRouterRouting',
  'vercelGatewayRouting',
]);
export const PROVIDER_FIELDS = new Set([
  'baseUrl',
  'apiKey',
  'api',
  'headers',
  'compat',
  'remoteCompaction',
  'authHeader',
  'auth',
  'discovery',
  'models',
  'modelOverrides',
  'disableStrictTools',
  'transport',
]);
export const MODEL_FIELDS = new Set([
  'id',
  'name',
  'api',
  'baseUrl',
  'reasoning',
  'thinking',
  'input',
  'supportsTools',
  'cost',
  'premiumMultiplier',
  'contextWindow',
  'maxTokens',
  'omitMaxOutputTokens',
  'headers',
  'compat',
  'contextPromotionTarget',
  'compactionModel',
  'remoteCompaction',
]);
export const MODEL_OVERRIDE_FIELDS = new Set(
  [...MODEL_FIELDS].filter((field) => field !== 'id' && field !== 'api' && field !== 'baseUrl')
);
export const THINKING_FIELDS = new Set([
  'mode',
  'efforts',
  'defaultLevel',
  'effortMap',
  'supportsDisplay',
  'minLevel',
  'maxLevel',
  'levels',
]);
export const COST_FIELDS = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);
export const TOP_LEVEL_FIELDS = new Set([
  'transport',
  'minLevel',
  'defaultLevel',
  'maxLevel',
  'levelOverrides',
  'modelsConfig',
  'auth',
  'tools',
  'nestedAgents',
  'mcp',
]);
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
export const MODEL_COMPONENT = /^\S+$/;
