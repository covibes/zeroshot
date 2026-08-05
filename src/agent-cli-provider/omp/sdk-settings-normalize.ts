import { invalidField } from '../contract-errors';
import { isRecord } from '../json';
import { EFFORTS, LEVELS, TOP_LEVEL_FIELDS } from './sdk-settings-constants';
import { normalizeAuth } from './sdk-settings-auth';
import { normalizeModelsConfig, validateSelectedProviderAuth } from './sdk-settings-model';
import { parseExactOmpModelSelector } from './sdk-settings-selector';
import {
  OMP_SDK_TOOL_IDS,
  type ConfiguredOmpSdkSettings,
  type OmpLevelOverride,
  type OmpModelLevel,
  type OmpModelsConfig,
  type OmpSdkSettings,
  type OmpSdkToolId,
  type OmpSettingsValidationContext,
} from './sdk-settings-types';
import {
  deepFreeze,
  enumValue,
  falseOnly,
  levelValue,
  rejectUnknown,
  stableValue,
} from './sdk-settings-values';

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

class OmpSdkSettingsFunctions {
  static normalizeOmpSdkSettings(
    input: unknown,
    context: OmpSettingsValidationContext & { readonly requireModelConfiguration: true }
  ): Readonly<ConfiguredOmpSdkSettings>;
  static normalizeOmpSdkSettings(
    input: unknown,
    context?: OmpSettingsValidationContext
  ): Readonly<OmpSdkSettings>;
  static normalizeOmpSdkSettings(
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
    const auth = input.auth === undefined ? undefined : normalizeAuth(input.auth, context);
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
    const mcp = falseOnly(input.mcp ?? OMP_SDK_SETTINGS_DEFAULTS.mcp, 'providerSettings.omp.mcp');

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

  static resolveOmpSdkSettings(
    settings: unknown,
    context: OmpSettingsValidationContext & { readonly requireModelConfiguration: true }
  ): Readonly<ConfiguredOmpSdkSettings>;
  static resolveOmpSdkSettings(
    settings: unknown,
    context?: OmpSettingsValidationContext
  ): Readonly<OmpSdkSettings>;
  static resolveOmpSdkSettings(
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
    return OmpSdkSettingsFunctions.normalizeOmpSdkSettings(omp === undefined ? {} : omp, context);
  }
}

export const normalizeOmpSdkSettings = OmpSdkSettingsFunctions.normalizeOmpSdkSettings;
export const resolveOmpSdkSettings = OmpSdkSettingsFunctions.resolveOmpSdkSettings;

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

function normalizeLevelOverrides(value: unknown): Partial<Record<OmpModelLevel, OmpLevelOverride>> {
  if (!isRecord(value)) {
    invalidField('providerSettings.omp.levelOverrides', 'OMP levelOverrides must be an object.');
  }
  rejectUnknown(value, new Set(LEVELS), 'providerSettings.omp.levelOverrides');
  if (Object.keys(value).length === 0) return {};
  const result: Partial<Record<OmpModelLevel, OmpLevelOverride>> = {};
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
    const selector = parseExactOmpModelSelector(override.model);
    const reasoningEffort = enumValue(
      override.reasoningEffort,
      EFFORTS,
      `${field}.reasoningEffort`
    );
    result[level] = { model: `${selector.provider}/${selector.model}`, reasoningEffort };
  }
  return result;
}

function normalizeTools(value: unknown): OmpSdkToolId[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidField('providerSettings.omp.tools', 'OMP tools must be a non-empty allowlist.');
  }
  const result: OmpSdkToolId[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isOmpSdkToolId(item)) {
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
    result.push(item);
  }
  return result;
}

function isOmpSdkToolId(value: unknown): value is OmpSdkToolId {
  return typeof value === 'string' && OMP_SDK_TOOL_IDS.some((candidate) => candidate === value);
}
