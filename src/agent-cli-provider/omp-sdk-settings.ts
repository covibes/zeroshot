import * as path from 'node:path';

import { invalidField } from './contract-errors';
import { isRecord } from './json';

export const OMP_SDK_TOOL_IDS = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'glob',
  'lsp',
  'ast_edit',
] as const;
export const OMP_SDK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OMP_AUTH_BROKER_ENV_NAMES = Object.freeze({
  url: 'OMP_AUTH_BROKER_URL',
  token: 'OMP_AUTH_BROKER_TOKEN',
});


export type OmpSdkToolId = (typeof OMP_SDK_TOOL_IDS)[number];
export type OmpTransport = 'sdk' | 'rpc';
export type OmpModelLevel = 'level1' | 'level2' | 'level3';
export type OmpReasoningEffort = (typeof OMP_SDK_REASONING_EFFORTS)[number];
export type OmpExecutionContext = 'host' | 'detached' | 'docker';

export interface ExactOmpModelSelector {
  readonly provider: string;
  readonly model: string;
}

export interface OmpLevelOverride {
  readonly model: string;
  readonly reasoningEffort: OmpReasoningEffort;
}

export interface OmpEnvironmentAuth {
  readonly mode: 'environment';
  readonly credentials: Readonly<Record<string, { readonly env: string }>>;
}

export interface OmpBrokerAuth {
  readonly mode: 'broker';
}

export interface OmpHomeAuth {
  readonly mode: 'omp-home';
  /** Explicit OMP agent/config directory containing agent.db, not a HOME root. */
  readonly path: string;
}

export interface OmpNoneAuth {
  readonly mode: 'none';
}

export type OmpSdkAuth = OmpEnvironmentAuth | OmpBrokerAuth | OmpHomeAuth | OmpNoneAuth;

export interface OmpModelDefinition {
  readonly [field: string]: unknown;
  readonly id: string;
}

export interface OmpProviderConfig {
  readonly [field: string]: unknown;
}

export interface OmpModelsConfig {
  readonly providers: Readonly<Record<string, OmpProviderConfig>>;
}

export interface OmpSdkSettings {
  readonly transport: OmpTransport;
  readonly minLevel: OmpModelLevel;
  readonly defaultLevel: OmpModelLevel;
  readonly maxLevel: OmpModelLevel;
  readonly levelOverrides: Readonly<Partial<Record<OmpModelLevel, OmpLevelOverride>>>;
  readonly modelsConfig: OmpModelsConfig;
  readonly auth?: OmpSdkAuth;
  readonly tools: readonly OmpSdkToolId[];
  readonly nestedAgents: false;
  readonly mcp: false;
}

export interface ConfiguredOmpSdkSettings extends OmpSdkSettings {
  readonly levelOverrides: Readonly<Record<OmpModelLevel, OmpLevelOverride>>;
  readonly auth: OmpSdkAuth;
}

export interface OmpSettingsValidationContext {
  readonly executionContext?: OmpExecutionContext;
  readonly requireModelConfiguration?: boolean;
}
const LEVELS = ['level1', 'level2', 'level3'] as const;
const EFFORTS = OMP_SDK_REASONING_EFFORTS;
const APIS = [
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
const INPUT_TYPES = ['text', 'image'] as const;
const THINKING_MODES = [
  'effort',
  'budget',
  'google-level',
  'anthropic-adaptive',
  'anthropic-budget-effort',
] as const;
const COMPAT_FIELDS = new Set([
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
const COMPAT_STRING_ENUMS = {
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  reasoningContentField: ['reasoning_content', 'reasoning', 'reasoning_text'],
  thinkingFormat: ['openai', 'openrouter', 'zai', 'qwen', 'qwen-chat-template'],
  cacheControlFormat: ['anthropic'],
  toolStrictMode: ['all_strict', 'none'],
  promptCacheMode: ['none', 'automatic', 'explicit'],
} as const;
const COMPAT_NUMBER_FIELDS = new Set([
  'streamIdleTimeoutMs',
  'promptCacheMinimumTokens',
  'promptCacheMaximumCheckpoints',
]);
const COMPAT_RECORD_FIELDS = new Set([
  'reasoningEffortMap',
  'openRouterRouting',
  'vercelGatewayRouting',
]);
const PROVIDER_FIELDS = new Set([
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
const MODEL_FIELDS = new Set([
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
const MODEL_OVERRIDE_FIELDS = new Set(
  [...MODEL_FIELDS].filter((field) => field !== 'id' && field !== 'api' && field !== 'baseUrl')
);
const THINKING_FIELDS = new Set([
  'mode',
  'efforts',
  'defaultLevel',
  'effortMap',
  'supportsDisplay',
  'minLevel',
  'maxLevel',
  'levels',
]);
const COST_FIELDS = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);
const TOP_LEVEL_FIELDS = new Set([
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
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_COMPONENT = /^\S+$/;


export const OMP_SDK_SETTINGS_DEFAULTS: Readonly<OmpSdkSettings> = deepFreeze<OmpSdkSettings>({
  transport: 'sdk',
  minLevel: 'level1',
  defaultLevel: 'level2',
  maxLevel: 'level3',
  levelOverrides: {},
  modelsConfig: { providers: {} },
  tools: [...OMP_SDK_TOOL_IDS],
  nestedAgents: false,
  mcp: false,
});

export function parseExactOmpModelSelector(selector: unknown): ExactOmpModelSelector {
  if (typeof selector !== 'string' || selector.length === 0 || selector !== selector.trim()) {
    invalidField(
      'modelSelector',
      'OMP model selectors must be non-empty strings without surrounding whitespace.'
    );
  }
  const separator = selector.indexOf('/');
  const provider = separator === -1 ? '' : selector.slice(0, separator);
  const model = separator === -1 ? '' : selector.slice(separator + 1);
  if (
    !PROVIDER_ID.test(provider) ||
    !MODEL_COMPONENT.test(model) ||
    model.length === 0 ||
    model.includes(',') ||
    model.startsWith('@')
  ) {
    invalidField(
      'modelSelector',
      'OMP model selectors must be exact full provider/model selectors with no fallback chain or alias.'
    );
  }
  return { provider, model };
}

export function normalizeOmpSdkSettings(
  input: unknown,
  context: OmpSettingsValidationContext & { readonly requireModelConfiguration: true }
): Readonly<ConfiguredOmpSdkSettings>;
export function normalizeOmpSdkSettings(
  input: unknown,
  context?: OmpSettingsValidationContext
): Readonly<OmpSdkSettings>;
export function normalizeOmpSdkSettings(
  input: unknown,
  context: OmpSettingsValidationContext = {}
): Readonly<OmpSdkSettings> {
  if (!isRecord(input)) {
    invalidField('providerSettings.omp', 'providerSettings.omp must be an object.');
  }
  rejectUnknown(input, TOP_LEVEL_FIELDS, 'providerSettings.omp');

  const transport = enumValue(
    input.transport ?? OMP_SDK_SETTINGS_DEFAULTS.transport,
    ['sdk', 'rpc'] as const,
    'providerSettings.omp.transport'
  );
  const minLevel = levelValue(
    input.minLevel ?? OMP_SDK_SETTINGS_DEFAULTS.minLevel,
    'providerSettings.omp.minLevel'
  );
  const defaultLevel = levelValue(
    input.defaultLevel ?? OMP_SDK_SETTINGS_DEFAULTS.defaultLevel,
    'providerSettings.omp.defaultLevel'
  );
  const maxLevel = levelValue(
    input.maxLevel ?? OMP_SDK_SETTINGS_DEFAULTS.maxLevel,
    'providerSettings.omp.maxLevel'
  );
  if (
    LEVELS.indexOf(minLevel) > LEVELS.indexOf(defaultLevel) ||
    LEVELS.indexOf(defaultLevel) > LEVELS.indexOf(maxLevel)
  ) {
    invalidField(
      'providerSettings.omp.defaultLevel',
      'OMP level bounds must satisfy minLevel <= defaultLevel <= maxLevel.'
    );
  }

  const levelOverrides = normalizeLevelOverrides(
    input.levelOverrides ?? OMP_SDK_SETTINGS_DEFAULTS.levelOverrides
  );
  const configuredLevelOverrides = hasAllLevelOverrides(levelOverrides)
    ? levelOverrides
    : undefined;
  const hasModelConfiguration = configuredLevelOverrides !== undefined;
  if (context.requireModelConfiguration === true && !hasModelConfiguration) {
    invalidField(
      'providerSettings.omp.levelOverrides',
      'OMP execution requires explicit full provider/model selectors for every level.'
    );
  }
  const auth =
    input.auth === undefined ? undefined : normalizeAuth(input.auth, context);
  if (hasModelConfiguration && auth === undefined) {
    invalidField(
      'providerSettings.omp.auth',
      'Configured OMP models require an explicit authentication mode.'
    );
  }
  const modelsConfig = normalizeModelsConfig(
    input.modelsConfig ?? OMP_SDK_SETTINGS_DEFAULTS.modelsConfig,
    auth
  );
  if (configuredLevelOverrides !== undefined && auth !== undefined) {
    validateSelectedProviderAuth(configuredLevelOverrides, modelsConfig, auth);
  }

  const tools = normalizeTools(input.tools ?? OMP_SDK_SETTINGS_DEFAULTS.tools);
  const nestedAgents = falseOnly(
    input.nestedAgents ?? OMP_SDK_SETTINGS_DEFAULTS.nestedAgents,
    'providerSettings.omp.nestedAgents'
  );
  const mcp = falseOnly(
    input.mcp ?? OMP_SDK_SETTINGS_DEFAULTS.mcp,
    'providerSettings.omp.mcp'
  );

  return deepFreeze({
    transport,
    minLevel,
    defaultLevel,
    maxLevel,
    levelOverrides,
    modelsConfig,
    ...(auth === undefined ? {} : { auth }),
    tools,
    nestedAgents,
    mcp,
  });
}

export function resolveOmpSdkSettings(
  settings: unknown,
  context: OmpSettingsValidationContext & { readonly requireModelConfiguration: true }
): Readonly<ConfiguredOmpSdkSettings>;
export function resolveOmpSdkSettings(
  settings: unknown,
  context?: OmpSettingsValidationContext
): Readonly<OmpSdkSettings>;
export function resolveOmpSdkSettings(
  settings: unknown,
  context: OmpSettingsValidationContext = {}
): Readonly<OmpSdkSettings> {
  if (!isRecord(settings)) {
    invalidField('settings', 'Zeroshot settings must be an object.');
  }
  const providerSettings = settings.providerSettings;
  if (providerSettings !== undefined && !isRecord(providerSettings)) {
    invalidField('providerSettings', 'providerSettings must be an object.');
  }
  const omp = providerSettings?.omp;
  return normalizeOmpSdkSettings(omp === undefined ? {} : omp, context);
}

export function validateOmpSdkSettings(
  settings: Record<string, unknown>,
  context: OmpSettingsValidationContext = {}
): string | null {
  try {
    normalizeOmpSdkSettings(settings, context);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid providerSettings.omp configuration.';
  }
}

export function compilePrivateOmpModelsYaml(
  input: Readonly<OmpSdkSettings> | OmpModelsConfig
): string {
  const modelsConfig =
    'modelsConfig' in input
      ? normalizeOmpSdkSettings(input).modelsConfig
      : normalizeModelsConfig(input);
  return `${JSON.stringify(stableValue({ providers: modelsConfig.providers }), null, 2)}\n`;
}

function hasAllLevelOverrides(
  value: Readonly<Partial<Record<OmpModelLevel, OmpLevelOverride>>>
): value is Readonly<Record<OmpModelLevel, OmpLevelOverride>> {
  return LEVELS.every((level) => value[level] !== undefined);
}

function normalizeLevelOverrides(
  value: unknown
): Partial<Record<OmpModelLevel, OmpLevelOverride>> {

  if (!isRecord(value)) {
    invalidField('providerSettings.omp.levelOverrides', 'OMP levelOverrides must be an object.');
  }
  rejectUnknown(value, new Set(LEVELS), 'providerSettings.omp.levelOverrides');
  if (Object.keys(value).length === 0) return {};
  const result = {} as Record<OmpModelLevel, OmpLevelOverride>;
  for (const level of LEVELS) {
    const override = value[level];
    const field = `providerSettings.omp.levelOverrides.${level}`;
    if (!isRecord(override)) {
      invalidField(field, `${field} is required and must be an object.`);
    }
    rejectUnknown(override, new Set(['model', 'reasoningEffort']), field);
    if (!Object.prototype.hasOwnProperty.call(override, 'model')) {
      invalidField(`${field}.model`, `${field}.model is required.`);
    }
    const selector = override.model;
    parseExactOmpModelSelector(selector);
    const reasoningEffort = enumValue(
      override.reasoningEffort,
      EFFORTS,
      `${field}.reasoningEffort`
    );
    result[level] = { model: selector as string, reasoningEffort };
  }
  return result;
}

function normalizeAuth(value: unknown, context: OmpSettingsValidationContext): OmpSdkAuth {
  if (!isRecord(value)) {
    invalidField('providerSettings.omp.auth', 'OMP auth must be a discriminated object.');
  }
  const mode = enumValue(
    value.mode,
    ['environment', 'broker', 'omp-home', 'none'] as const,
    'providerSettings.omp.auth.mode'
  );
  if (mode === 'environment') {
    rejectUnknown(value, new Set(['mode', 'credentials']), 'providerSettings.omp.auth');
    if (!isRecord(value.credentials) || Object.keys(value.credentials).length === 0) {
      invalidField(
        'providerSettings.omp.auth.credentials',
        'Environment auth requires at least one provider credential reference.'
      );
    }
    const credentials: Record<string, { env: string }> = {};
    for (const [provider, credential] of Object.entries(value.credentials)) {
      assertProviderId(provider, `providerSettings.omp.auth.credentials.${provider}`);
      if (!isRecord(credential)) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}`,
          'Provider credential references must be objects.'
        );
      }
      rejectUnknown(
        credential,
        new Set(['env']),
        `providerSettings.omp.auth.credentials.${provider}`
      );
      if (typeof credential.env !== 'string' || !ENV_NAME.test(credential.env)) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}.env`,
          'Credential references must contain only a valid environment variable name.'
        );
      }
      credentials[provider] = { env: credential.env };
    }
    return { mode, credentials };
  }
  if (mode === 'broker') {
    rejectUnknown(value, new Set(['mode']), 'providerSettings.omp.auth');
    return { mode };
  }
  if (mode === 'none') {
    rejectUnknown(value, new Set(['mode']), 'providerSettings.omp.auth');
    return { mode };
  }

  rejectUnknown(value, new Set(['mode', 'path']), 'providerSettings.omp.auth');
  if (context.executionContext !== undefined && context.executionContext !== 'host') {
    invalidField(
      'providerSettings.omp.auth.mode',
      'omp-home authentication is local host-only and forbidden for detached or Docker execution.'
    );
  }
  if (
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    value.path.trim() !== value.path
  ) {
    invalidField(
      'providerSettings.omp.auth.path',
      'omp-home authentication requires an explicit absolute local path.'
    );
  }
  return { mode, path: path.normalize(value.path) };
}

function normalizeModelsConfig(value: unknown, auth?: OmpSdkAuth): OmpModelsConfig {
  if (!isRecord(value)) {
    invalidField('providerSettings.omp.modelsConfig', 'OMP modelsConfig must be an object.');
  }
  rejectUnknown(value, new Set(['providers']), 'providerSettings.omp.modelsConfig');
  const providerInput = value.providers ?? {};
  if (!isRecord(providerInput)) {
    invalidField(
      'providerSettings.omp.modelsConfig.providers',
      'OMP modelsConfig.providers must be an object.'
    );
  }
  const providers: Record<string, OmpProviderConfig> = {};
  for (const [provider, config] of Object.entries(providerInput)) {
    const field = `providerSettings.omp.modelsConfig.providers.${provider}`;
    assertProviderId(provider, field);
    providers[provider] = normalizeProviderConfig(provider, config, auth, field);
  }
  return { providers };
}

function normalizeProviderConfig(
  provider: string,
  value: unknown,
  auth: OmpSdkAuth | undefined,
  field: string
): OmpProviderConfig {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, PROVIDER_FIELDS, field);
  const result: Record<string, unknown> = {};

  if (value.baseUrl !== undefined) result.baseUrl = safeUrl(value.baseUrl, `${field}.baseUrl`);
  if (value.api !== undefined) result.api = enumValue(value.api, APIS, `${field}.api`);
  if (value.auth !== undefined) {
    const providerAuth = enumValue(
      value.auth,
      ['apiKey', 'none', 'oauth'] as const,
      `${field}.auth`
    );
    if (providerAuth === 'oauth') {
      invalidField(`${field}.auth`, 'Custom provider OAuth would read ambient state and is not accepted.');
    }
    result.auth = providerAuth;
  }
  if (value.transport !== undefined) {
    invalidField(
      `${field}.transport`,
      'Command/gateway-backed custom provider transports are not accepted.'
    );
  }
  if (value.discovery !== undefined) {
    invalidField(`${field}.discovery`, 'Dynamic custom provider discovery is not accepted.');
  }
  if (value.remoteCompaction !== undefined) {
    invalidField(`${field}.remoteCompaction`, 'Remote compaction config is not accepted.');
  }
  if (value.headers !== undefined) result.headers = emptyHeaders(value.headers, `${field}.headers`);
  if (value.compat !== undefined) result.compat = normalizeCompat(value.compat, `${field}.compat`);
  if (value.authHeader !== undefined) {
    result.authHeader = booleanValue(value.authHeader, `${field}.authHeader`);
  }
  if (value.disableStrictTools !== undefined) {
    result.disableStrictTools = booleanValue(
      value.disableStrictTools,
      `${field}.disableStrictTools`
    );
  }

  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      invalidField(`${field}.models`, 'Custom provider models must be a non-empty array.');
    }
    result.models = value.models.map((model, index) =>
      normalizeModelDefinition(model, `${field}.models[${index}]`)
    );
    if (result.baseUrl === undefined) {
      invalidField(`${field}.baseUrl`, 'baseUrl is required when defining custom models.');
    }
    const hasProviderApi = result.api !== undefined;
    const models = result.models as readonly Record<string, unknown>[];
    const seenModelIds = new Set<string>();
    for (const model of models) {
      const modelId = model.id as string;
      if (seenModelIds.has(modelId)) {
        invalidField(`${field}.models`, `Custom model id ${modelId} is duplicated.`);
      }
      seenModelIds.add(modelId);
    }
    if (!hasProviderApi && models.some((model) => model.api === undefined)) {
      invalidField(
        `${field}.api`,
        'api is required at provider or every model when defining custom models.'
      );
    }
  }

  if (value.modelOverrides !== undefined) {
    if (!isRecord(value.modelOverrides)) {
      invalidField(`${field}.modelOverrides`, 'modelOverrides must be an object.');
    }
    const overrides: Record<string, unknown> = {};
    for (const [model, override] of Object.entries(value.modelOverrides)) {
      if (model.length === 0 || !MODEL_COMPONENT.test(model)) {
        invalidField(
          `${field}.modelOverrides`,
          'modelOverrides keys must be non-empty model IDs.'
        );
      }
      overrides[model] = normalizeModelOverride(
        override,
        `${field}.modelOverrides.${model}`
      );
    }
    result.modelOverrides = overrides;
  }

  const credentialEnv = auth?.mode === 'environment' ? auth.credentials[provider]?.env : undefined;
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string' || !ENV_NAME.test(value.apiKey)) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must be an environment variable name; literals and command-backed values are forbidden.'
      );
    }
    if (auth?.mode === 'environment' && credentialEnv === undefined) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must match a declared environment credential reference for this provider.'
      );
    }
    if (credentialEnv !== undefined && value.apiKey !== credentialEnv) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must match the declared environment credential reference.'
      );
    }
    if (auth !== undefined && auth.mode !== 'environment') {
      invalidField(`${field}.apiKey`, `${auth.mode} auth forbids provider apiKey configuration.`);
    }
    result.apiKey = value.apiKey;
  } else if (value.models !== undefined && result.auth !== 'none') {
    if (auth?.mode === 'environment' && credentialEnv !== undefined) {
      result.apiKey = credentialEnv;
    } else if (auth !== undefined) {
      invalidField(
        `${field}.apiKey`,
        'Authenticated custom models require an environment credential reference; broker and omp-home custom-provider credentials cannot be materialized safely.'
      );
    }
  }
  if (auth?.mode === 'none' && result.auth !== 'none') {
    invalidField(`${field}.auth`, 'Keyless settings require custom providers to declare auth: none.');
  }
  return result;
}

function normalizeModelDefinition(value: unknown, field: string): OmpModelDefinition {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, MODEL_FIELDS, field);
  if (typeof value.id !== 'string' || value.id.length === 0 || !MODEL_COMPONENT.test(value.id)) {
    invalidField(`${field}.id`, 'Custom model id must be a non-empty string without whitespace.');
  }
  const result: Record<string, unknown> = { id: value.id };
  copyModelFields(value, result, field, true);
  return result as OmpModelDefinition;
}

function normalizeModelOverride(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, MODEL_OVERRIDE_FIELDS, field);
  const result: Record<string, unknown> = {};
  copyModelFields(value, result, field, false);
  return result;
}

function copyModelFields(
  value: Record<string, unknown>,
  result: Record<string, unknown>,
  field: string,
  allowApiAndBaseUrl: boolean
): void {
  if (value.name !== undefined) result.name = nonEmptyString(value.name, `${field}.name`);
  if (allowApiAndBaseUrl && value.api !== undefined) {
    result.api = enumValue(value.api, APIS, `${field}.api`);
  }
  if (allowApiAndBaseUrl && value.baseUrl !== undefined) {
    result.baseUrl = safeUrl(value.baseUrl, `${field}.baseUrl`);
  }
  for (const key of ['reasoning', 'supportsTools', 'omitMaxOutputTokens'] as const) {
    if (value[key] !== undefined) result[key] = booleanValue(value[key], `${field}.${key}`);
  }
  for (const key of ['premiumMultiplier', 'contextWindow', 'maxTokens'] as const) {
    if (value[key] !== undefined) {
      result[key] = nonNegativeNumber(value[key], `${field}.${key}`);
    }
  }
  for (const key of ['contextPromotionTarget', 'compactionModel'] as const) {
    if (value[key] !== undefined) result[key] = nonEmptyString(value[key], `${field}.${key}`);
  }
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.length === 0) {
      invalidField(`${field}.input`, 'input must be a non-empty text/image array.');
    }
    result.input = value.input.map((item, index) =>
      enumValue(item, INPUT_TYPES, `${field}.input[${index}]`)
    );
  }
  if (value.thinking !== undefined) {
    result.thinking = normalizeThinking(value.thinking, `${field}.thinking`);
  }
  if (value.cost !== undefined) {
    result.cost = normalizeCost(value.cost, `${field}.cost`, allowApiAndBaseUrl);
  }
  if (value.headers !== undefined) result.headers = emptyHeaders(value.headers, `${field}.headers`);
  if (value.compat !== undefined) result.compat = normalizeCompat(value.compat, `${field}.compat`);
  if (value.remoteCompaction !== undefined) {
    invalidField(`${field}.remoteCompaction`, 'Remote compaction config is not accepted.');
  }
}

function normalizeThinking(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, THINKING_FIELDS, field);
  const result: Record<string, unknown> = {
    mode: enumValue(value.mode, THINKING_MODES, `${field}.mode`),
  };
  for (const key of ['efforts', 'levels'] as const) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length === 0) {
        invalidField(`${field}.${key}`, `${key} must be a non-empty effort array.`);
      }
      result[key] = value[key].map((item, index) =>
        enumValue(item, EFFORTS, `${field}.${key}[${index}]`)
      );
    }
  }
  for (const key of ['defaultLevel', 'minLevel', 'maxLevel'] as const) {
    if (value[key] !== undefined) {
      result[key] = enumValue(value[key], EFFORTS, `${field}.${key}`);
    }
  }
  if (value.supportsDisplay !== undefined) {
    result.supportsDisplay = booleanValue(value.supportsDisplay, `${field}.supportsDisplay`);
  }
  if (value.effortMap !== undefined) {
    result.effortMap = normalizeEffortMap(value.effortMap, `${field}.effortMap`);
  }
  const hasEfforts = result.efforts !== undefined || result.levels !== undefined;
  if (!hasEfforts && (result.minLevel === undefined || result.maxLevel === undefined)) {
    invalidField(field, 'thinking requires efforts, levels, or both minLevel and maxLevel.');
  }
  return result;
}

function normalizeEffortMap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, new Set(EFFORTS), field);
  const result: Record<string, string> = {};
  for (const [effort, mapped] of Object.entries(value)) {
    result[effort] = nonEmptyString(mapped, `${field}.${effort}`);
  }
  return result;
}

function normalizeCost(
  value: unknown,
  field: string,
  requireAllFields: boolean
): Record<string, number> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, COST_FIELDS, field);
  if (requireAllFields) {
    const missing = [...COST_FIELDS].find((key) => value[key] === undefined);
    if (missing !== undefined) {
      invalidField(`${field}.${missing}`, `${field}.${missing} is required.`);
    }
  }
  const result: Record<string, number> = {};
  for (const key of COST_FIELDS) {
    if (value[key] !== undefined) {
      result[key] = nonNegativeNumber(value[key], `${field}.${key}`);
    }
  }
  return result;
}

function normalizeCompat(
  value: unknown,
  field: string,
  allowWhenThinking = true
): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, COMPAT_FIELDS, field);
  if (Object.prototype.hasOwnProperty.call(value, 'extraBody')) {
    invalidField(
      `${field}.extraBody`,
      'Arbitrary request bodies may contain persisted secrets and are not accepted.'
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'whenThinking') {
      if (!allowWhenThinking) {
        invalidField(`${field}.whenThinking`, 'Nested compat.whenThinking is not a native OMP field.');
      }
      result[key] = normalizeCompat(item, `${field}.whenThinking`, false);
      continue;
    }
    if (COMPAT_RECORD_FIELDS.has(key)) {
      result[key] =
        key === 'reasoningEffortMap'
          ? normalizeEffortMap(item, `${field}.${key}`)
          : normalizeRouting(item, `${field}.${key}`);
      continue;
    }
    if (COMPAT_NUMBER_FIELDS.has(key)) {
      result[key] = nonNegativeNumber(item, `${field}.${key}`);
      continue;
    }
    if (key === 'maxTokensField') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.maxTokensField, `${field}.${key}`);
      continue;
    }
    if (key === 'reasoningContentField') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.reasoningContentField, `${field}.${key}`);
      continue;
    }
    if (key === 'thinkingFormat') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.thinkingFormat, `${field}.${key}`);
      continue;
    }
    if (key === 'cacheControlFormat') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.cacheControlFormat, `${field}.${key}`);
      continue;
    }
    if (key === 'toolStrictMode') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.toolStrictMode, `${field}.${key}`);
      continue;
    }
    if (key === 'promptCacheMode') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.promptCacheMode, `${field}.${key}`);
      continue;
    }
    result[key] = booleanValue(item, `${field}.${key}`);
  }
  return result;
}

function normalizeRouting(value: unknown, field: string): Record<string, readonly string[]> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, new Set(['only', 'order']), field);
  const result: Record<string, readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item)) invalidField(`${field}.${key}`, `${field}.${key} must be an array.`);
    result[key] = item.map((entry, index) =>
      nonEmptyString(entry, `${field}.${key}[${index}]`)
    );
  }
  return result;
}

function validateSelectedProviderAuth(
  levels: Readonly<Record<OmpModelLevel, OmpLevelOverride>>,
  modelsConfig: OmpModelsConfig,
  auth: OmpSdkAuth
): void {
  const selectors = LEVELS.map((level) =>
    parseExactOmpModelSelector(levels[level].model)
  );
  const providers = new Set(selectors.map(({ provider }) => provider));
  for (const { provider, model } of selectors) {
    const configuredModels = modelsConfig.providers[provider]?.models;
    if (
      Array.isArray(configuredModels) &&
      !configuredModels.some((configured) => isRecord(configured) && configured.id === model)
    ) {
      invalidField(
        `providerSettings.omp.levelOverrides`,
        `Selected custom model ${provider}/${model} is not declared in modelsConfig.`
      );
    }
  }
  if (auth.mode === 'environment') {
    for (const provider of providers) {
      const custom = modelsConfig.providers[provider];
      if (custom?.auth === 'none') {
        invalidField(
          `providerSettings.omp.auth.mode`,
          `Selected keyless provider ${provider} requires auth mode none.`
        );
      }
      if (auth.credentials[provider] === undefined) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}`,
          `Environment auth is missing a credential reference for selected provider ${provider}.`
        );
      }
    }
  }
  if (auth.mode === 'none') {
    for (const provider of providers) {
      const custom = modelsConfig.providers[provider];
      if (custom !== undefined && custom.auth !== 'none') {
        invalidField(
          `providerSettings.omp.modelsConfig.providers.${provider}.auth`,
          `Selected custom provider ${provider} must declare auth: none for keyless execution.`
        );
      }
    }
  }
  if (auth.mode === 'broker') {
    for (const provider of providers) {
      if (modelsConfig.providers[provider]?.models !== undefined) {
        invalidField(
          `providerSettings.omp.modelsConfig.providers.${provider}`,
          'Broker auth cannot safely satisfy OMP custom-provider apiKey config; use environment auth.'
        );
      }
    }
  }
}

function normalizeTools(value: unknown): OmpSdkToolId[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidField('providerSettings.omp.tools', 'OMP tools must be a non-empty allowlist.');
  }
  const result: OmpSdkToolId[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !OMP_SDK_TOOL_IDS.includes(item as OmpSdkToolId)) {
      invalidField(
        `providerSettings.omp.tools[${index}]`,
        `OMP tools are restricted to: ${OMP_SDK_TOOL_IDS.join(', ')}.`
      );
    }
    if (seen.has(item)) {
      invalidField(
        `providerSettings.omp.tools[${index}]`,
        'OMP tool allowlists cannot contain duplicates.'
      );
    }
    seen.add(item);
    result.push(item as OmpSdkToolId);
  }
  return result;
}

function safeUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    invalidField(field, `${field} must be a non-empty URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidField(field, `${field} must be an absolute URL.`);
  }
  if (parsed.username || parsed.password) {
    invalidField(field, `${field} must not contain URL userinfo.`);
  }
  if (parsed.search || parsed.hash) {
    invalidField(field, `${field} must not contain query parameters or fragments.`);
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    invalidField(field, `${field} must use HTTPS, except for loopback HTTP providers.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function emptyHeaders(value: unknown, field: string): Record<string, never> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  if (Object.keys(value).length !== 0) {
    invalidField(field, 'Literal custom headers may persist credentials and are not accepted.');
  }
  return {};
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    invalidField(`${field}.${unknown}`, `Unknown OMP setting: ${field}.${unknown}.`);
  }
}

function levelValue(value: unknown, field: string): OmpModelLevel {
  return enumValue(value, LEVELS, field);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  invalidField(field, `${field} must be one of: ${allowed.join(', ')}.`);
}

function falseOnly(value: unknown, field: string): false {
  if (value === false) return false;
  invalidField(field, `${field} must be false.`);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  invalidField(field, `${field} must be a boolean.`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\0')
  ) {
    return value;
  }
  invalidField(field, `${field} must be a non-empty string without surrounding whitespace.`);
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  invalidField(field, `${field} must be a finite non-negative number.`);
}

function assertProviderId(provider: string, field: string): void {
  if (!PROVIDER_ID.test(provider)) {
    invalidField(
      field,
      'OMP provider IDs must use lowercase letters, numbers, dots, underscores, or hyphens.'
    );
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
