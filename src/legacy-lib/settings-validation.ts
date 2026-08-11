interface SettingsRecord extends Record<string, unknown> {}

interface DockerConfigFacade {
  validateMountConfig(value: unknown): string | null;
  validateEnvPassthrough(value: unknown): string | null;
}

interface ProviderNamesFacade {
  VALID_PROVIDERS: readonly string[];
  normalizeProviderName<T>(name: T): T | string;
  normalizeProviderSettings<T>(settings: T): T | Record<string, unknown>;
}

interface DefaultsFacade {
  DEFAULT_SETTINGS: SettingsRecord;
}

interface ModelsFacade {
  VALID_MODELS: readonly string[];
}

interface ProviderFacade {
  validateSettings(settings: unknown): string | null;
}

interface ProvidersFacade {
  getProvider(providerId: string): ProviderFacade;
}

interface IssueProviderLoaderFacade {
  getIssueProviderFns(): {
    listProviders(): readonly string[];
    validateIssueProviderSetting(key: string, value: unknown): string | null | undefined;
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const dockerConfig: DockerConfigFacade = require('./docker-config');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const defaults: DefaultsFacade = require('./settings-defaults');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const models: ModelsFacade = require('./settings-models');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const issueProviders: IssueProviderLoaderFacade = require('./settings-issue-providers');

const { validateMountConfig, validateEnvPassthrough } = dockerConfig;
const { VALID_PROVIDERS, normalizeProviderName, normalizeProviderSettings } = providerNames;
const { DEFAULT_SETTINGS } = defaults;
const { VALID_MODELS } = models;
const { getIssueProviderFns } = issueProviders;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function includesUnknown(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

function validateClaudeCommand(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'claudeCommand must be a string';
  }
  if (value.trim().length === 0) {
    return 'claudeCommand cannot be empty';
  }
  return null;
}

function validateProviderSettings(value: unknown): string | null {
  const normalizedSettings = normalizeProviderSettings(value);
  if (!isUnknownRecord(value)) {
    return 'providerSettings must be an object';
  }

  if (!isUnknownRecord(normalizedSettings)) {
    return 'providerSettings must be an object';
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const providers: ProvidersFacade = require('../src/providers');
  for (const [providerName, settings] of Object.entries(normalizedSettings)) {
    if (!VALID_PROVIDERS.includes(providerName)) {
      return `Unknown provider in providerSettings: ${providerName}. Valid providers: ${VALID_PROVIDERS.join(', ')}`;
    }

    try {
      const provider = providers.getProvider(providerName);
      const error = provider.validateSettings(settings);
      if (error) return error;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to validate ${providerName} settings: ${message}`;
    }
  }
  return null;
}

function validateIssueSourceSetting(key: string, value: unknown): string | null | undefined {
  if (key === 'defaultIssueSource') {
    const validSources = getIssueProviderFns().listProviders();
    if (!includesUnknown(validSources, value)) {
      return `Invalid issue source: ${String(value)}. Valid: ${validSources.join(', ')}`;
    }
    return null;
  }
  return getIssueProviderFns().validateIssueProviderSetting(key, value);
}

const POSITIVE_INTEGER_SETTINGS = [
  'maxRetries',
  'maxRestartAttempts',
  'maxTotalRestarts',
  'staleWarningsBeforeKill',
  'backoffBaseMs',
  'backoffMaxMs',
];

function validateNumberSetting(key: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${key} must be a number`;
  }
  if (!Number.isInteger(value)) {
    return `${key} must be an integer`;
  }
  const min = ['backoffBaseMs', 'backoffMaxMs'].includes(key) ? 0 : 1;
  return value < min ? `${key} must be >= ${min}` : null;
}

function validateSetting(key: string, value: unknown): string | null {
  if (!(key in DEFAULT_SETTINGS)) {
    return `Unknown setting: ${key}`;
  }

  if (POSITIVE_INTEGER_SETTINGS.includes(key)) {
    const error = validateNumberSetting(key, value);
    if (error) return error;
  }
  if (key === 'jitterFactor') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 'jitterFactor must be a number';
    }
    if (value < 0 || value > 1) {
      return 'jitterFactor must be between 0 and 1';
    }
  }
  if (key === 'maxModel' && !includesUnknown(VALID_MODELS, value)) {
    return `Invalid model: ${String(value)}. Valid models: ${VALID_MODELS.join(', ')}`;
  }
  if (key === 'minModel' && value !== null && !includesUnknown(VALID_MODELS, value)) {
    return `Invalid model: ${String(value)}. Valid models: ${VALID_MODELS.join(', ')}, null`;
  }
  if (key === 'logLevel' && !includesUnknown(['quiet', 'normal', 'verbose'], value)) {
    return `Invalid log level: ${String(value)}. Valid levels: quiet, normal, verbose`;
  }
  if (key === 'defaultDelivery' && !includesUnknown(['none', 'pr', 'ship'], value)) {
    return `Invalid defaultDelivery: ${String(value)}. Valid: none, pr, ship`;
  }
  if (key === 'defaultIsolation' && !includesUnknown(['none', 'worktree', 'docker'], value)) {
    return `Invalid defaultIsolation: ${String(value)}. Valid: none, worktree, docker`;
  }
  if (key === 'claudeCommand') return validateClaudeCommand(value);
  if (key === 'defaultProvider') {
    const normalized = normalizeProviderName(value);
    if (typeof normalized !== 'string' || !VALID_PROVIDERS.includes(normalized)) {
      return `Invalid provider: ${String(value)}. Valid providers: ${VALID_PROVIDERS.join(', ')}`;
    }
  }
  if (key === 'providerSettings') return validateProviderSettings(value);
  if (key === 'dockerMounts') return validateMountConfig(value);
  if (key === 'dockerEnvPassthrough') return validateEnvPassthrough(value);

  const issueSourceError = validateIssueSourceSetting(key, value);
  return issueSourceError === undefined ? null : issueSourceError;
}

function coerceValue(key: string, value: unknown): unknown {
  const defaultValue = DEFAULT_SETTINGS[key];
  if (key === 'minModel' && (value === 'null' || value === null)) return null;
  if (typeof defaultValue === 'boolean') {
    return value === 'true' || value === '1' || value === 'yes' || value === true;
  }
  if (typeof defaultValue === 'number') {
    const parsed = parseFloat(String(value));
    if (isNaN(parsed)) throw new Error(`Invalid number: ${String(value)}`);
    return parsed;
  }
  if (Array.isArray(defaultValue)) {
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new Error(`${key} must be an array`);
        return parsed;
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          throw new Error(`Invalid JSON for ${key}: ${value}`);
        }
        throw error;
      }
    }
    return value;
  }
  if (key === 'providerSettings') {
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        return normalizeProviderSettings(parsed);
      } catch {
        throw new Error(`Invalid JSON for providerSettings: ${value}`);
      }
    }
    return normalizeProviderSettings(value);
  }
  if (key === 'defaultProvider') return normalizeProviderName(value);
  return value;
}

export = { validateSetting, coerceValue };
