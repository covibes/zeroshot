import { getProviderAdapter } from './adapters';
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
}

export interface RuntimeProviderProbe {
  readonly available: boolean;
  readonly helpText: string;
  readonly versionText: string;
  readonly capabilities: ProviderCliFeatures;
}

type MutableModelSpec = {
  level?: ModelLevel;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
};

const MODEL_LEVELS: readonly ModelLevel[] = ['level1', 'level2', 'level3'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
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
  const baseOptions = input.options ?? {};
  const settings = loadRuntimeSettings();
  const adapter = adapterForRuntimeInput(input.provider, settings);
  const providerSettings = runtimeProviderSettings(
    settings,
    adapter.id,
    baseOptions.cwd ?? process.cwd()
  );
  const cliFeatures = resolveRuntimeCliFeatures(adapter.id, baseOptions.cliFeatures);
  const authEnv = baseOptions.authEnv ?? resolveRuntimeAuthEnv(adapter.id, settings);
  const options = buildRuntimeOptions(baseOptions, adapter, providerSettings, cliFeatures, authEnv);
  return {
    adapter,
    options,
    cliFeatures,
    commandSpec: adapter.buildCommand(input.context, options),
  };
}

export function detectRuntimeProviderCliFeatures(provider: string): ProviderCliFeatures {
  return probeRuntimeProviderCli(provider).capabilities;
}

function resolveRuntimeCliFeatures(
  provider: ProviderId,
  overrides: CliFeatureOverrides | undefined
): CliFeatureOverrides {
  if (provider === 'gateway') {
    return {
      ...detectRuntimeProviderCliFeatures(provider),
      ...overrides,
      supportsBundledRunner: true,
    };
  }
  if (getProviderRegistryEntry(provider).invoke.lane !== 'acp-stdio') {
    return overrides ?? detectRuntimeProviderCliFeatures(provider);
  }

  const detected = detectRuntimeProviderCliFeatures(provider);
  if (overrides === undefined) return detected;
  return mergeAcpFailClosedCliFeatures(detected, overrides);
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
    supportsPromptImages:
      detected.supportsPromptImages && overrides.supportsPromptImages !== false,
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

export function probeRuntimeProviderCli(provider: string): RuntimeProviderProbe {
  const adapter = getProviderAdapter(provider);
  if (adapter.id === 'gateway') {
    return probeGatewayProvider(adapter);
  }
  const helpCommand = runtimeHelpCommand(adapter.id);
  const commandAvailable = booleanResult(commandExistsFn(helpCommand.command));
  if (!commandAvailable) {
    return {
      available: false,
      helpText: '',
      versionText: '',
      capabilities: adapter.detectCliFeatures(''),
    };
  }

  const helpText = stringResult(getHelpOutputFn(helpCommand.command, helpCommand.args)).trim();
  const versionText = stringResult(getVersionOutputFn(helpCommand.command, helpCommand.args)).trim();
  const availabilityProbe = getProviderRegistryEntry(adapter.id).availabilityProbe ?? 'command';

  return {
    available: availabilityProbe === 'help-or-version' ? Boolean(helpText || versionText) : true,
    helpText,
    versionText,
    capabilities: adapter.detectCliFeatures(helpText),
  };
}

function buildRuntimeOptions(
  baseOptions: BuildProviderCommandOptions,
  adapter: ProviderAdapter,
  providerSettings: RuntimeProviderSettings,
  cliFeatures: CliFeatureOverrides,
  authEnv: Readonly<Record<string, string>>
): BuildProviderCommandOptions {
  const modelSpec = resolveRuntimeModelSpec(adapter, baseOptions.modelSpec, providerSettings);
  const gateway = resolveRuntimeGatewayOptions(
    adapter.id,
    baseOptions,
    providerSettings,
    modelSpec
  );
  const resolved = {
    ...baseOptions,
    modelSpec,
    ...(gateway === undefined ? {} : { gateway }),
    cliFeatures,
  };
  if (baseOptions.jsonSchema && !supportsProviderCapability(adapter.id, 'jsonSchema')) {
    if (!shouldIncludeAuthEnv(baseOptions, authEnv)) {
      return { ...resolved, strictSchema: false };
    }
    return { ...resolved, authEnv, strictSchema: false };
  }
  if (!shouldIncludeAuthEnv(baseOptions, authEnv)) return resolved;
  return { ...resolved, authEnv };
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
    ...(requestGateway.baseUrl ?? settingsGateway.baseUrl
      ? { baseUrl: requestGateway.baseUrl ?? settingsGateway.baseUrl }
      : {}),
    ...(requestGateway.apiKey ?? settingsGateway.apiKey
      ? { apiKey: requestGateway.apiKey ?? settingsGateway.apiKey }
      : {}),
    ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
    model: requestGateway.model ?? modelSpec.model ?? settingsGateway.model ?? null,
    ...(requestGateway.toolPolicy ?? settingsGateway.toolPolicy
      ? { toolPolicy: requestGateway.toolPolicy ?? settingsGateway.toolPolicy }
      : {}),
  };
  return resolveGatewayConfiguration(
    mergedGateway,
    'options.gateway',
    cwd
  );
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
  const configured = provider ?? optionalString(settings.defaultProvider, 'settings.defaultProvider');
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
  const gateway =
    provider === 'gateway'
      ? normalizeGatewayBuildOptions(
          providerSettings,
          'settings.providerSettings.gateway',
          cwd
        )
      : undefined;
  if (defaultLevel === undefined) {
    return gateway === undefined ? { levelOverrides } : { levelOverrides, gateway };
  }
  return gateway === undefined ? { defaultLevel, levelOverrides } : { defaultLevel, levelOverrides, gateway };
}

function runtimeHelpCommand(provider: ProviderId): CommandParts {
  if (provider === 'claude') {
    return commandPartsFromUnknown(getClaudeCommandFn(), 'getClaudeCommand');
  }
  return resolveProviderCommand(provider);
}

function probeGatewayProvider(adapter: ProviderAdapter): RuntimeProviderProbe {
  const capabilities = adapter.detectCliFeatures('');
  try {
    const settings = loadRuntimeSettings();
    const providerSettings = runtimeProviderSettings(settings, 'gateway', process.cwd());
    resolveGatewayConfiguration(providerSettings.gateway, 'settings.providerSettings.gateway', process.cwd());
    return {
      available: true,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
    };
  } catch {
    return {
      available: false,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
    };
  }
}

function loadRuntimeSettings(): Record<string, unknown> {
  const settings = loadSettingsFn();
  return requiredRecord(settings, 'loadSettings');
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

function stringRecordFromUnknown(
  value: unknown,
  field: string
): Readonly<Record<string, string>> {
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
