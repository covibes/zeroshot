import { getProviderAdapter } from './adapters';
import { UnsupportedProviderCapabilityError } from './errors';
import { normalizeGatewayBuildOptions, resolveGatewayConfiguration } from './gateway-tools';
import { isRecord } from './json';
import {
  getProviderRegistryEntry,
  resolveProviderCommand,
  supportsProviderCapability,
} from './provider-registry';
import type {
  BuildProviderCommandOptions,
  CliFeatureOverrides,
  CommandSpec,
  GatewayBuildOptions,
  LevelOverrides,
  ModelLevel,
  ModelSpec,
  ProviderAdapter,
  ProviderCliFeatures,
  ProviderId,
  ResolvedGatewayBuildOptions,
  ReasoningEffort,
  WebSearchAttestation,
} from './types';

type UnknownFunction = (...args: readonly unknown[]) => unknown;

interface CommandParts {
  readonly command: string;
  readonly args: readonly string[];
}

interface RuntimeProviderSettings {
  readonly defaultLevel?: ModelLevel;
  readonly levelOverrides: LevelOverrides;
  readonly gateway?: GatewayBuildOptions;
  readonly webSearch?: boolean;
}

interface RuntimeCommandContext {
  readonly cliFeatures: CliFeatureOverrides;
  readonly authEnv: Readonly<Record<string, string>>;
}

export interface SingleAgentProviderCommandInput {
  readonly provider?: string | null;
  readonly context: string;
  readonly options?: BuildProviderCommandOptions;
}

export interface PreparedSingleAgentProviderCommand {
  readonly adapter: ProviderAdapter;
  readonly commandSpec: CommandSpec;
  readonly options: BuildProviderCommandOptions;
  readonly cliFeatures: CliFeatureOverrides;
  readonly configuration: {
    readonly webSearch: WebSearchAttestation;
  };
}

export interface RuntimeProviderProbe {
  readonly available: boolean;
  readonly helpText: string;
  readonly versionText: string;
  readonly capabilities: ProviderCliFeatures;
  readonly configuration: {
    readonly webSearch: WebSearchAttestation;
  };
}

interface RuntimeProbeEvidence {
  readonly available?: boolean;
  readonly helpText: string;
  readonly versionText: string;
}

type MutableModelSpec = {
  level?: ModelLevel;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
};

const MODEL_LEVELS: readonly ModelLevel[] = ['level1', 'level2', 'level3'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV = 'ZEROSHOT_ISOLATED_PROVIDER_SETTINGS_JSON';
const settingsModule: unknown = require('../../lib/settings');
const providerDetectionModule: unknown = require('../../lib/provider-detection');
const claudeAuthModule: unknown = require('../../lib/settings/claude-auth');

const loadSettingsFn = moduleFunction(settingsModule, 'loadSettings');
const getClaudeCommandFn = moduleFunction(settingsModule, 'getClaudeCommand');
const commandExistsFn = moduleFunction(providerDetectionModule, 'commandExists');
const getHelpOutputFn = moduleFunction(providerDetectionModule, 'getHelpOutput');
const getVersionOutputFn = moduleFunction(providerDetectionModule, 'getVersionOutput');
const resolveClaudeAuthFn = moduleFunction(claudeAuthModule, 'resolveClaudeAuth');

export function prepareSingleAgentProviderCommand(
  input: SingleAgentProviderCommandInput
): PreparedSingleAgentProviderCommand {
  rejectCallerSuppliedModelProvenance(input);
  const baseOptions = input.options ?? {};
  const settings = loadRuntimeSettings();
  const adapter = adapterForRuntimeInput(input.provider, settings);
  const providerSettings = runtimeProviderSettings(
    settings,
    adapter.id,
    baseOptions.cwd ?? process.cwd()
  );
  const requestedWebSearch = baseOptions.webSearch ?? providerSettings.webSearch;
  assertWebSearchDeclared(adapter.id, requestedWebSearch);
  const cliFeatures = resolveRuntimeCliFeatures(
    adapter.id,
    baseOptions.cliFeatures,
    requestedWebSearch === true
  );
  const authEnv = baseOptions.authEnv ?? resolveRuntimeAuthEnv(adapter.id, settings);
  const options = buildRuntimeOptions(baseOptions, adapter, providerSettings, {
    cliFeatures,
    authEnv,
  });
  return {
    adapter,
    options,
    cliFeatures,
    configuration: {
      webSearch: webSearchAttestation(options),
    },
    commandSpec: adapter.buildCommand(input.context, options),
  };
}

export function detectRuntimeProviderCliFeatures(provider: string): ProviderCliFeatures {
  return probeRuntimeProviderCli(provider).capabilities;
}

function resolveRuntimeCliFeatures(
  provider: ProviderId,
  overrides: CliFeatureOverrides | undefined,
  webSearchRequested: boolean
): CliFeatureOverrides {
  if (provider === 'gateway') {
    const detected = detectRuntimeProviderCliFeatures(provider);
    return {
      ...detected,
      ...overrides,
      supportsBundledRunner: true,
      supportsWebSearch: false,
    };
  }
  if (getProviderRegistryEntry(provider).invoke.lane === 'acp-stdio') {
    const detected = detectRuntimeProviderCliFeatures(provider);
    if (overrides === undefined) return detected;
    return mergeAcpFailClosedCliFeatures(detected, overrides);
  }
  if (overrides === undefined) return detectRuntimeProviderCliFeatures(provider);
  if (!webSearchRequested) return overrides;
  const detected = detectRuntimeProviderCliFeatures(provider);
  return {
    ...overrides,
    supportsResume:
      'supportsResume' in detected &&
      detected.supportsResume === true &&
      overrides.supportsResume !== false,
    supportsWebSearch:
      detected.supportsWebSearch === true && overrides.supportsWebSearch !== false,
  };
}

function mergeAcpFailClosedCliFeatures(
  detected: ProviderCliFeatures,
  overrides: CliFeatureOverrides
): CliFeatureOverrides {
  if (!('supportsAcpStdio' in detected)) return overrides;
  return {
    ...detected,
    ...overrides,
    supportsAcpStdio: detected.supportsAcpStdio && overrides.supportsAcpStdio !== false,
    supportsPromptImages: detected.supportsPromptImages && overrides.supportsPromptImages !== false,
    supportsLoadSession: detected.supportsLoadSession && overrides.supportsLoadSession !== false,
    supportsSessionCancel:
      detected.supportsSessionCancel && overrides.supportsSessionCancel !== false,
    supportsSessionSetModel:
      detected.supportsSessionSetModel && overrides.supportsSessionSetModel !== false,
    supportsSessionSetMode:
      detected.supportsSessionSetMode && overrides.supportsSessionSetMode !== false,
    supportsRemoteTransport: false,
    supportsCustomTransport: false,
    supportsPermissionRequests: false,
    supportsFsTools: false,
    supportsTerminalTools: false,
  };
}

export function probeRuntimeProviderCli(
  provider: string,
  evidence?: RuntimeProbeEvidence
): RuntimeProviderProbe {
  const adapter = getProviderAdapter(provider);
  if (adapter.id === 'gateway') {
    return probeGatewayProvider(adapter);
  }
  const requested = getProviderRegistryEntry(adapter.id).settingsFields.includes('webSearch')
    ? runtimeProviderSettings(loadRuntimeSettings(), adapter.id, process.cwd()).webSearch === true
    : false;
  const helpCommand = runtimeHelpCommand(adapter.id);
  const commandAvailable =
    evidence === undefined
      ? booleanResult(commandExistsFn(helpCommand.command))
      : evidence.available !== false;
  if (!commandAvailable) {
    const capabilities = attestedCliFeatures(adapter, '', '');
    return {
      available: false,
      helpText: '',
      versionText: '',
      capabilities,
      configuration: {
        webSearch: webSearchAttestation({ webSearch: requested, cliFeatures: capabilities }),
      },
    };
  }

  const helpText =
    evidence?.helpText ??
    stringResult(getHelpOutputFn(helpCommand.command, helpCommand.args)).trim();
  const versionText =
    evidence?.versionText ??
    stringResult(
      getVersionOutputFn(
        helpCommand.command,
        getProviderRegistryEntry(adapter.id).capabilities.webSearch === true
          ? []
          : helpCommand.args
      )
    ).trim();
  const availabilityProbe = getProviderRegistryEntry(adapter.id).availabilityProbe ?? 'command';
  const capabilities = attestedCliFeatures(adapter, helpText, versionText);

  return {
    available:
      evidence?.available ??
      (availabilityProbe === 'help-or-version' ? Boolean(helpText || versionText) : true),
    helpText,
    versionText,
    capabilities,
    configuration: {
      webSearch: webSearchAttestation({ webSearch: requested, cliFeatures: capabilities }),
    },
  };
}

function buildRuntimeOptions(
  baseOptions: BuildProviderCommandOptions,
  adapter: ProviderAdapter,
  providerSettings: RuntimeProviderSettings,
  runtime: RuntimeCommandContext
): BuildProviderCommandOptions {
  const modelSpec = resolveRuntimeModelSpec(adapter, baseOptions.modelSpec, providerSettings);
  const gateway = resolveRuntimeGatewayOptions(
    adapter.id,
    baseOptions,
    providerSettings,
    modelSpec
  );
  const webSearch = baseOptions.webSearch ?? providerSettings.webSearch;
  assertWebSearchDeclared(adapter.id, webSearch);
  const resolved = {
    ...baseOptions,
    modelSpec,
    ...(gateway === undefined ? {} : { gateway }),
    ...(webSearch === undefined ? {} : { webSearch }),
    cliFeatures: runtime.cliFeatures,
  };
  if (baseOptions.jsonSchema && !supportsProviderCapability(adapter.id, 'jsonSchema')) {
    if (!shouldIncludeAuthEnv(baseOptions, runtime.authEnv)) {
      return { ...resolved, strictSchema: false };
    }
    return { ...resolved, authEnv: runtime.authEnv, strictSchema: false };
  }
  if (!shouldIncludeAuthEnv(baseOptions, runtime.authEnv)) return resolved;
  return { ...resolved, authEnv: runtime.authEnv };
}

function resolveRuntimeGatewayOptions(
  provider: ProviderId,
  baseOptions: BuildProviderCommandOptions,
  providerSettings: RuntimeProviderSettings,
  modelSpec: ModelSpec
): ResolvedGatewayBuildOptions | undefined {
  if (provider !== 'gateway') return undefined;
  const cwd = baseOptions.cwd ?? process.cwd();
  const settingsGateway = providerSettings.gateway ?? {};
  const requestGateway = baseOptions.gateway ?? {};
  const mergedHeaders =
    requestGateway.headers === undefined
      ? settingsGateway.headers
      : { ...(settingsGateway.headers ?? {}), ...requestGateway.headers };
  const mergedGateway: GatewayBuildOptions = {
    ...(requestGateway.protocol ?? settingsGateway.protocol
      ? { protocol: requestGateway.protocol ?? settingsGateway.protocol }
      : {}),
    ...((requestGateway.baseUrl ?? settingsGateway.baseUrl)
      ? { baseUrl: requestGateway.baseUrl ?? settingsGateway.baseUrl }
      : {}),
    ...((requestGateway.apiKey ?? settingsGateway.apiKey)
      ? { apiKey: requestGateway.apiKey ?? settingsGateway.apiKey }
      : {}),
    ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
    model: requestGateway.model ?? modelSpec.model ?? settingsGateway.model ?? null,
    ...(requestGateway.maxTokens ?? settingsGateway.maxTokens
      ? { maxTokens: requestGateway.maxTokens ?? settingsGateway.maxTokens }
      : {}),
    ...((requestGateway.toolPolicy ?? settingsGateway.toolPolicy)
      ? { toolPolicy: requestGateway.toolPolicy ?? settingsGateway.toolPolicy }
      : {}),
  };
  return resolveGatewayConfiguration(mergedGateway, 'options.gateway', cwd);
}

function shouldIncludeAuthEnv(
  baseOptions: BuildProviderCommandOptions,
  authEnv: Readonly<Record<string, string>>
): boolean {
  return baseOptions.authEnv !== undefined || Object.keys(authEnv).length > 0;
}

function resolveRuntimeModelSpec(
  adapter: ProviderAdapter,
  explicit: ModelSpec | undefined,
  providerSettings: RuntimeProviderSettings
): ModelSpec {
  if (explicit?.model !== undefined) {
    adapter.validateModelId(explicit.model);
    return explicit;
  }

  const level = explicit?.level ?? providerSettings.defaultLevel ?? adapter.defaultLevel;
  const resolved = adapter.resolveModelSpec(level, providerSettings.levelOverrides);
  const modelSpec = modelSpecFromResolved(resolved);
  if (explicit?.reasoningEffort === undefined) return modelSpec;
  return { ...modelSpec, reasoningEffort: explicit.reasoningEffort };
}

function modelSpecFromResolved(resolved: {
  readonly level: ModelLevel;
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | undefined;
}): ModelSpec {
  const result: MutableModelSpec = {
    level: resolved.level,
    model: resolved.model,
  };
  if (resolved.reasoningEffort !== undefined) result.reasoningEffort = resolved.reasoningEffort;
  return result;
}

function resolveRuntimeAuthEnv(
  provider: ProviderId,
  settings: Record<string, unknown>
): Readonly<Record<string, string>> {
  if (provider !== 'claude') return {};
  return stringRecordFromUnknown(resolveClaudeAuthFn(settings), 'resolveClaudeAuth');
}

function adapterForRuntimeInput(
  provider: string | null | undefined,
  settings: Record<string, unknown>
): ProviderAdapter {
  const configured =
    provider ?? optionalString(settings.defaultProvider, 'settings.defaultProvider');
  return getProviderAdapter(configured ?? 'claude');
}

function runtimeProviderSettings(
  settings: Record<string, unknown>,
  provider: ProviderId,
  cwd: string
): RuntimeProviderSettings {
  const allSettings = optionalRecord(settings.providerSettings, 'settings.providerSettings');
  const providerValue = allSettings?.[provider];
  if (providerValue === undefined) return { levelOverrides: {} };
  const providerSettings = requiredRecord(providerValue, `settings.providerSettings.${provider}`);
  const defaultLevel = optionalModelLevel(
    providerSettings.defaultLevel,
    `settings.providerSettings.${provider}.defaultLevel`
  );
  const levelOverrides = levelOverridesFromUnknown(
    providerSettings.levelOverrides,
    `settings.providerSettings.${provider}.levelOverrides`
  );
  const webSearch = optionalBoolean(
    providerSettings.webSearch,
    `settings.providerSettings.${provider}.webSearch`
  );
  const gateway =
    provider === 'gateway'
      ? normalizeGatewayBuildOptions(providerSettings, 'settings.providerSettings.gateway', cwd)
      : undefined;
  const base = {
    levelOverrides,
    ...(gateway === undefined ? {} : { gateway }),
    ...(webSearch === undefined ? {} : { webSearch }),
  };
  return defaultLevel === undefined ? base : { ...base, defaultLevel };
}

function runtimeHelpCommand(provider: ProviderId): CommandParts {
  if (provider === 'claude') {
    return commandPartsFromUnknown(getClaudeCommandFn(), 'getClaudeCommand');
  }
  return resolveProviderCommand(provider);
}

function probeGatewayProvider(adapter: ProviderAdapter): RuntimeProviderProbe {
  const capabilities = attestedCliFeatures(adapter, '', '');
  try {
    const settings = loadRuntimeSettings();
    const providerSettings = runtimeProviderSettings(settings, 'gateway', process.cwd());
    resolveGatewayConfiguration(
      providerSettings.gateway,
      'settings.providerSettings.gateway',
      process.cwd()
    );
    return {
      available: true,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
      configuration: {
        webSearch: { requested: false, effective: false },
      },
    };
  } catch {
    return {
      available: false,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
      configuration: {
        webSearch: { requested: false, effective: false },
      },
    };
  }
}

function attestedCliFeatures(
  adapter: ProviderAdapter,
  helpText: string,
  versionText: string
): ProviderCliFeatures {
  const detected = adapter.detectCliFeatures(helpText, versionText);
  return {
    ...detected,
    supportsWebSearch:
      getProviderRegistryEntry(adapter.id).capabilities.webSearch === true &&
      detected.supportsWebSearch === true,
  };
}

function webSearchAttestation(options: {
  readonly webSearch?: boolean;
  readonly cliFeatures?: CliFeatureOverrides;
}): WebSearchAttestation {
  const requested = options.webSearch === true;
  return {
    requested,
    effective: requested && options.cliFeatures?.supportsWebSearch === true,
  };
}

function assertWebSearchDeclared(provider: ProviderId, requested: boolean | undefined): void {
  if (requested === undefined || getProviderRegistryEntry(provider).capabilities.webSearch === true) {
    return;
  }
  throw new UnsupportedProviderCapabilityError(
    provider,
    'webSearch',
    `Provider ${provider} does not expose provider-controlled native web search; remove options.webSearch.`
  );
}

function loadRuntimeSettings(): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(process.env, LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV)) {
    throw new Error(
      `${LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV} is not a trusted settings channel; use the settings file.`
    );
  }
  return requiredRecord(loadSettingsFn(), 'loadSettings');
}

function rejectCallerSuppliedModelProvenance(input: SingleAgentProviderCommandInput): void {
  if (Object.prototype.hasOwnProperty.call(input, 'modelSpecSource')) {
    throw new Error(
      'modelSpecSource is not accepted at the child provider boundary; use modelLevel and effective provider settings.'
    );
  }
}

function moduleFunction(moduleValue: unknown, field: string): UnknownFunction {
  const record = requiredRecord(moduleValue, 'module');
  const value = record[field];
  if (isUnknownFunction(value)) return value;
  throw new Error(`Expected ${field} to be a function.`);
}

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

function commandPartsFromUnknown(value: unknown, field: string): CommandParts {
  const record = requiredRecord(value, field);
  return {
    command: requiredStringValue(record.command, `${field}.command`),
    args: stringArray(record.args, `${field}.args`),
  };
}

function levelOverridesFromUnknown(value: unknown, field: string): LevelOverrides {
  if (value === undefined) return {};
  const record = requiredRecord(value, field);
  const result: Partial<Record<ModelLevel, ModelSpec>> = {};
  for (const level of MODEL_LEVELS) {
    if (record[level] !== undefined) result[level] = modelSpecFromUnknown(record[level], field);
  }
  return result;
}

function modelSpecFromUnknown(value: unknown, field: string): ModelSpec {
  const record = requiredRecord(value, field);
  const result: MutableModelSpec = {};
  addModelLevel(result, record.level, `${field}.level`);
  addModel(result, record.model, `${field}.model`);
  addReasoningEffort(result, record.reasoningEffort, `${field}.reasoningEffort`);
  return result;
}

function addModelLevel(result: MutableModelSpec, value: unknown, field: string): void {
  const level = optionalModelLevel(value, field);
  if (level !== undefined) result.level = level;
}

function addModel(result: MutableModelSpec, value: unknown, field: string): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'string') {
    result.model = value;
    return;
  }
  throw new Error(`${field} must be a string or null.`);
}

function addReasoningEffort(result: MutableModelSpec, value: unknown, field: string): void {
  const effort = optionalReasoningEffort(value, field);
  if (effort !== undefined) result.reasoningEffort = effort;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${field} must be a boolean.`);
}

function optionalModelLevel(value: unknown, field: string): ModelLevel | undefined {
  if (value === undefined) return undefined;
  if (value === 'level1' || value === 'level2' || value === 'level3') return value;
  throw new Error(`${field} must be one of: ${MODEL_LEVELS.join(', ')}.`);
}

function optionalReasoningEffort(value: unknown, field: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value;
  }
  throw new Error(`${field} must be one of: ${REASONING_EFFORTS.join(', ')}.`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${field} must be a string.`);
}

function requiredStringValue(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${field} must be a non-empty string.`);
}

function optionalRecord(
  value: unknown,
  field: string
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredRecord(value, field);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${field} must be an object.`);
}

function stringRecordFromUnknown(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  const record = requiredRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string.`);
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings.`);
    result.push(item);
  }
  return result;
}

function stringResult(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new Error('Provider help output must be a string.');
}

function booleanResult(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error('Provider availability probe must return a boolean.');
}
