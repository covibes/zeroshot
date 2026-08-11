interface ProviderLevelSettings extends Record<string, unknown> {
  levelOverrides?: Record<string, unknown>;
}

type ProviderSettingsRecord = Record<string, ProviderLevelSettings>;

interface SettingsRecord extends Record<string, unknown> {
  autoCheckUpdates?: unknown;
  defaultDocker?: unknown;
  defaultIsolation?: unknown;
  defaultProvider?: unknown;
  lastUpdateCheckClaim?: unknown;
  providerSettings?: ProviderSettingsRecord;
}

interface ProviderDefaultsFacade {
  getProviderDefaults(): ProviderSettingsRecord;
}

interface ProviderNamesFacade {
  VALID_PROVIDERS: readonly string[];
  getDefaultProviderId(): string;
  normalizeProviderName<T>(name: T): T | string;
  normalizeProviderSettings<T>(settings: T): T | Record<string, unknown>;
}

interface SettingsModelsFacade {
  applyLegacyModelBounds(settings: SettingsRecord): SettingsRecord;
}

interface IssueProviderLoaderFacade {
  getIssueProviderFns(): {
    getIssueProviderSettingsDefaults(): SettingsRecord;
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerDefaults: ProviderDefaultsFacade = require('./provider-defaults');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const settingsModels: SettingsModelsFacade = require('./settings-models');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const issueProviders: IssueProviderLoaderFacade = require('./settings-issue-providers');

const { getProviderDefaults } = providerDefaults;
const {
  VALID_PROVIDERS,
  getDefaultProviderId,
  normalizeProviderName,
  normalizeProviderSettings,
} = providerNames;
const { applyLegacyModelBounds } = settingsModels;
const { getIssueProviderFns } = issueProviders;

const DEFAULT_SETTINGS_BASE: SettingsRecord = {
  maxModel: 'opus',
  minModel: null,
  defaultProvider: getDefaultProviderId(),
  get providerSettings(): ProviderSettingsRecord {
    return getProviderDefaults();
  },
  defaultConfig: 'conductor-bootstrap',
  defaultIsolation: 'none',
  defaultDelivery: 'none',
  setupVersion: null,
  strictSchema: true,
  logLevel: 'normal',
  autoCheckUpdates: true,
  lastUpdateCheckAt: null,
  lastSeenVersion: null,
  lastUpdateCheckClaim: null,
  claudeCommand: 'claude',
  dockerMounts: ['gh', 'git', 'ssh'],
  dockerEnvPassthrough: [],
  dockerContainerHome: '/home/node',
  maxRetries: 3,
  maxRestartAttempts: 3,
  maxTotalRestarts: 10,
  staleWarningsBeforeKill: 2,
  backoffBaseMs: 2000,
  backoffMaxMs: 30000,
  jitterFactor: 0.2,
  defaultIssueSource: 'github',
};

let defaultSettingsCache: SettingsRecord | null = null;

function getDefaultSettings(): SettingsRecord {
  if (!defaultSettingsCache) {
    const issueProviderSettings = getIssueProviderFns().getIssueProviderSettingsDefaults();
    defaultSettingsCache = {
      ...DEFAULT_SETTINGS_BASE,
      ...issueProviderSettings,
    };
  }
  return defaultSettingsCache;
}

function propertyValue(settings: SettingsRecord, property: PropertyKey): unknown {
  return typeof property === 'string' ? settings[property] : undefined;
}

const DEFAULT_SETTINGS: SettingsRecord = new Proxy(DEFAULT_SETTINGS_BASE, {
  get(target, property): unknown {
    if (property in target) {
      return propertyValue(target, property);
    }
    return propertyValue(getDefaultSettings(), property);
  },
  has(target, property): boolean {
    if (property in target) return true;
    return property in getDefaultSettings();
  },
  ownKeys(): string[] {
    return Object.keys(getDefaultSettings());
  },
  getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
    const merged = getDefaultSettings();
    if (property in merged) {
      return { enumerable: true, configurable: true, value: propertyValue(merged, property) };
    }
    return undefined;
  },
});

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerOverride(value: unknown, provider: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) return {};
  const selected = value[provider];
  return isUnknownRecord(selected) ? selected : {};
}

function mergeProviderSettings(
  current: ProviderSettingsRecord,
  overrides?: unknown
): ProviderSettingsRecord {
  const providerDefaultsValue = getProviderDefaults();
  const merged: ProviderSettingsRecord = {};

  for (const provider of VALID_PROVIDERS) {
    merged[provider] = {
      ...(providerDefaultsValue[provider] || {}),
      ...(current[provider] || {}),
      ...providerOverride(overrides, provider),
    };
    if (!merged[provider].levelOverrides) {
      merged[provider].levelOverrides = {};
    }
  }
  return merged;
}

function normalizeLoadedSettings(parsed: SettingsRecord): SettingsRecord {
  const normalized = { ...parsed };
  if (!Object.hasOwn(parsed, 'defaultIsolation') && typeof parsed.defaultDocker === 'boolean') {
    normalized.defaultIsolation = parsed.defaultDocker ? 'docker' : 'none';
  }
  delete normalized.defaultDocker;
  if (parsed.defaultProvider) {
    normalized.defaultProvider = normalizeProviderName(parsed.defaultProvider);
  }
  if (parsed.providerSettings) {
    const normalizedProviders = normalizeProviderSettings(parsed.providerSettings);
    if (isProviderSettingsRecord(normalizedProviders)) {
      normalized.providerSettings = normalizedProviders;
    }
  }
  if (
    normalized.autoCheckUpdates === false ||
    typeof normalized.lastUpdateCheckClaim !== 'string' ||
    normalized.lastUpdateCheckClaim.trim().length === 0
  ) {
    normalized.lastUpdateCheckClaim = null;
  }
  return normalized;
}

function isProviderSettingsRecord(value: unknown): value is ProviderSettingsRecord {
  return isUnknownRecord(value);
}

function resolvedDefaultSettings(): SettingsRecord {
  return {
    ...DEFAULT_SETTINGS,
    providerSettings: mergeProviderSettings(getProviderDefaults()),
  };
}

function mergeLoadedSettings(parsed: SettingsRecord): SettingsRecord {
  const normalized = normalizeLoadedSettings(parsed);
  const merged = { ...resolvedDefaultSettings(), ...normalized };
  merged.defaultProvider =
    normalizeProviderName(merged.defaultProvider) || DEFAULT_SETTINGS.defaultProvider;
  merged.providerSettings = mergeProviderSettings(
    getProviderDefaults(),
    normalized.providerSettings
  );
  if (
    merged.autoCheckUpdates === false ||
    typeof merged.lastUpdateCheckClaim !== 'string' ||
    merged.lastUpdateCheckClaim.trim().length === 0
  ) {
    merged.lastUpdateCheckClaim = null;
  }
  return applyLegacyModelBounds(merged);
}

export = { DEFAULT_SETTINGS, resolvedDefaultSettings, mergeLoadedSettings };
