/**
 * Settings management for zeroshot
 * Persistent user preferences stored in ~/.zeroshot/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const lockfile = require('proper-lockfile');
const { validateMountConfig, validateEnvPassthrough } = require('./docker-config');
const {
  VALID_PROVIDERS,
  normalizeProviderName,
  normalizeProviderSettings,
} = require('./provider-names');

const SETTINGS_LOCK_STALE_MS = 5000;
const SETTINGS_LOCK_TIMEOUT_MS = 500;
const SETTINGS_LOCK_RETRY_MS = 20;
const SETTINGS_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

class SettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

// Lazy-loaded to avoid circular dependency (issue-providers → settings → issue-providers)
let _issueProviderFns = null;
function getIssueProviderFns() {
  if (!_issueProviderFns) {
    _issueProviderFns = require('../src/issue-providers');
  }
  return _issueProviderFns;
}

/**
 * Get settings file path (dynamically reads env var for testing)
 * Using a getter ensures tests can override the path at runtime
 * @returns {string}
 */
function getSettingsFile() {
  return (
    process.env.ZEROSHOT_SETTINGS_FILE || path.join(os.homedir(), '.zeroshot', 'settings.json')
  );
}

/**
 * Whether the global settings file exists on disk (vs. running on defaults).
 * @returns {boolean}
 */
function settingsFileExists() {
  return fs.existsSync(getSettingsFile());
}

// Import provider defaults from separate module to avoid circular dependency
const { getProviderDefaults, clearProviderDefaultsCache } = require('./provider-defaults');

/**
 * Model hierarchy for cost ceiling validation
 * Higher number = more expensive/capable model
 */
const MODEL_HIERARCHY = {
  opus: 3,
  fable: 3,
  sonnet: 2,
  haiku: 1,
};

const VALID_MODELS = Object.keys(MODEL_HIERARCHY);
const LEVEL_RANKS = { level1: 1, level2: 2, level3: 3 };

/**
 * Validate a requested model against the maxModel ceiling and minModel floor
 * @param {string} requestedModel - Model the agent wants to use
 * @param {string} maxModel - Maximum allowed model (cost ceiling)
 * @param {string|null} minModel - Minimum required model (cost floor)
 * @returns {string} The validated model
 * @throws {Error} If requested model exceeds ceiling or falls below floor
 */
function validateModelAgainstMax(requestedModel, maxModel, minModel = null) {
  if (!requestedModel) return maxModel; // Default to ceiling if unspecified

  if (!VALID_MODELS.includes(requestedModel)) {
    throw new Error(`Invalid model "${requestedModel}". Valid: ${VALID_MODELS.join(', ')}`);
  }
  if (!VALID_MODELS.includes(maxModel)) {
    throw new Error(`Invalid maxModel "${maxModel}". Valid: ${VALID_MODELS.join(', ')}`);
  }

  if (MODEL_HIERARCHY[requestedModel] > MODEL_HIERARCHY[maxModel]) {
    throw new Error(
      `Agent requests "${requestedModel}" but maxModel is "${maxModel}". ` +
        `Either lower agent's model or raise maxModel.`
    );
  }

  if (minModel) {
    if (!VALID_MODELS.includes(minModel)) {
      throw new Error(`Invalid minModel "${minModel}". Valid: ${VALID_MODELS.join(', ')}`);
    }
    if (MODEL_HIERARCHY[minModel] > MODEL_HIERARCHY[maxModel]) {
      throw new Error(`minModel "${minModel}" cannot be higher than maxModel "${maxModel}".`);
    }
    if (MODEL_HIERARCHY[requestedModel] < MODEL_HIERARCHY[minModel]) {
      throw new Error(
        `Agent requests "${requestedModel}" but minModel is "${minModel}". ` +
          `Either raise agent's model or lower minModel.`
      );
    }
  }

  return requestedModel;
}

// Default settings (base - without issue provider settings which are added dynamically)
const DEFAULT_SETTINGS_BASE = {
  maxModel: 'opus', // Cost ceiling - agents cannot use models above this
  minModel: null, // Cost floor - agents cannot use models below this (null = no minimum)
  defaultProvider: 'claude',
  get providerSettings() {
    // Dynamically build from providers on first access
    return getProviderDefaults();
  },
  defaultConfig: 'conductor-bootstrap',
  defaultDocker: false,
  defaultDelivery: 'none', // 'none' | 'pr' | 'ship' - folded into resolveEffectiveRunPlan same as defaultDocker
  strictSchema: true, // true = reliable json output (default), false = live streaming (may crash - see bold-meadow-11)
  logLevel: 'normal',
  // Automatic update notification cache
  autoCheckUpdates: true, // Check npm registry for newer versions
  lastUpdateCheckAt: null, // Unix timestamp of last automatic attempt (null = never checked)
  lastSeenVersion: null, // Compatibility key containing the cached valid npm-latest version
  lastUpdateCheckClaim: null, // Opaque ownership token for an in-flight automatic refresh
  // Claude command - customize how to invoke Claude CLI (default: 'claude')
  // Example: 'ccr code' for claude-code-router integration
  claudeCommand: 'claude',
  // Docker isolation mounts - preset names or {host, container, readonly?} objects
  // Valid presets: infrastructure presets plus provider ids from the provider registry
  dockerMounts: ['gh', 'git', 'ssh'],
  // Extra env vars to pass to Docker container (in addition to preset-implied ones)
  // Supports: VAR (if set), VAR_* (pattern), VAR=value (forced), VAR= (empty)
  dockerEnvPassthrough: [],
  // Container home directory - where $HOME resolves in container paths
  // Default: /home/node (matches zeroshot-cluster-base image)
  dockerContainerHome: '/home/node',
  // Retry/restart robustness defaults
  maxRetries: 3, // Agent task retries (per execution) for retryable errors
  maxRestartAttempts: 3, // Agent restarts since last TASK_COMPLETED
  maxTotalRestarts: 10, // Safety valve (never resets)
  staleWarningsBeforeKill: 2, // Consecutive stale warnings before restart
  backoffBaseMs: 2000, // Initial retry backoff
  backoffMaxMs: 30000, // Max retry backoff
  jitterFactor: 0.2, // Random jitter ±20%
  // Issue provider settings - defaultIssueSource is here, others come from providers
  defaultIssueSource: 'github', // 'github' | 'gitlab' | 'jira' | 'azure-devops'
};

// Cache for merged defaults (base + issue provider settings)
let _defaultSettingsCache = null;

/**
 * Get DEFAULT_SETTINGS with issue provider settings merged in
 * Lazy-loaded to avoid circular dependency at module load time
 */
function getDefaultSettings() {
  if (!_defaultSettingsCache) {
    const issueProviderDefaults = getIssueProviderFns().getIssueProviderSettingsDefaults();
    _defaultSettingsCache = {
      ...DEFAULT_SETTINGS_BASE,
      ...issueProviderDefaults,
    };
  }
  return _defaultSettingsCache;
}

// For backward compatibility, export DEFAULT_SETTINGS as a getter
const DEFAULT_SETTINGS = new Proxy(DEFAULT_SETTINGS_BASE, {
  get(target, prop) {
    // For known base properties, return from base
    if (prop in target) {
      return target[prop];
    }
    // For issue provider settings, get from merged defaults
    const merged = getDefaultSettings();
    return merged[prop];
  },
  has(target, prop) {
    if (prop in target) return true;
    const merged = getDefaultSettings();
    return prop in merged;
  },
  ownKeys() {
    const merged = getDefaultSettings();
    return Object.keys(merged);
  },
  getOwnPropertyDescriptor(target, prop) {
    const merged = getDefaultSettings();
    if (prop in merged) {
      return { enumerable: true, configurable: true, value: merged[prop] };
    }
    return undefined;
  },
});

function mapLegacyModelToLevel(model) {
  switch (model) {
    case 'haiku':
      return 'level1';
    case 'sonnet':
      return 'level2';
    case 'opus':
      return 'level3';
    default:
      return null;
  }
}

function mergeProviderSettings(current, overrides) {
  // Ensure current has all providers with their defaults
  const providerDefaults = getProviderDefaults();
  const merged = {};

  for (const provider of VALID_PROVIDERS) {
    merged[provider] = {
      ...(providerDefaults[provider] || {}),
      ...(current[provider] || {}),
      ...(overrides?.[provider] || {}),
    };
    if (!merged[provider].levelOverrides) {
      merged[provider].levelOverrides = {};
    }
  }
  return merged;
}

function applyLegacyModelBounds(settings) {
  if (!settings.providerSettings) return settings;
  const claude = settings.providerSettings.claude || {};
  const legacyMaxLevel = mapLegacyModelToLevel(settings.maxModel);
  const legacyMinLevel = mapLegacyModelToLevel(settings.minModel);

  if (legacyMaxLevel) {
    claude.maxLevel = legacyMaxLevel;
  }

  if (legacyMinLevel) {
    claude.minLevel = legacyMinLevel;
  }

  const minRank = LEVEL_RANKS[claude.minLevel] || LEVEL_RANKS.level1;
  const maxRank = LEVEL_RANKS[claude.maxLevel] || LEVEL_RANKS.level3;
  const defaultRank = LEVEL_RANKS[claude.defaultLevel] || LEVEL_RANKS.level2;

  if (minRank > maxRank) {
    claude.minLevel = 'level1';
    claude.maxLevel = 'level3';
  } else if (defaultRank < minRank) {
    claude.defaultLevel = claude.minLevel;
  } else if (defaultRank > maxRank) {
    claude.defaultLevel = claude.maxLevel;
  }

  settings.providerSettings.claude = claude;
  return settings;
}

function normalizeLoadedSettings(parsed) {
  const normalized = { ...parsed };
  if (parsed.defaultProvider) {
    normalized.defaultProvider = normalizeProviderName(parsed.defaultProvider);
  }
  if (parsed.providerSettings) {
    normalized.providerSettings = normalizeProviderSettings(parsed.providerSettings);
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

function resolvedDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    providerSettings: mergeProviderSettings(getProviderDefaults()),
  };
}

function mergeLoadedSettings(parsed) {
  const normalized = normalizeLoadedSettings(parsed);
  const merged = { ...resolvedDefaultSettings(), ...normalized };
  merged.defaultProvider =
    normalizeProviderName(merged.defaultProvider) || DEFAULT_SETTINGS.defaultProvider;
  merged.providerSettings = mergeProviderSettings(getProviderDefaults(), normalized.providerSettings);
  if (
    merged.autoCheckUpdates === false ||
    typeof merged.lastUpdateCheckClaim !== 'string' ||
    merged.lastUpdateCheckClaim.trim().length === 0
  ) {
    merged.lastUpdateCheckClaim = null;
  }
  return applyLegacyModelBounds(merged);
}

/**
 * Load settings from disk, merging with defaults
 */
function loadSettings(options = {}) {
  const settingsFile = getSettingsFile();
  if (!fs.existsSync(settingsFile)) {
    return resolvedDefaultSettings();
  }
  try {
    return mergeLoadedSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
  } catch {
    if (!options.silent) console.error('Warning: Could not load settings, using defaults');
    return resolvedDefaultSettings();
  }
}

function readSettingsForMutation(settingsFile) {
  if (!fs.existsSync(settingsFile)) {
    return {
      settings: resolvedDefaultSettings(),
      requiresClaimInvalidation: false,
      requiresRecovery: false,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const updatesDisabled = parsed.autoCheckUpdates === false || parsed.updatePolicy === 'off';
    return {
      settings: mergeLoadedSettings(parsed),
      requiresClaimInvalidation: updatesDisabled && parsed.lastUpdateCheckClaim !== null,
      requiresRecovery: false,
    };
  } catch {
    return {
      settings: resolvedDefaultSettings(),
      requiresClaimInvalidation: false,
      requiresRecovery: true,
    };
  }
}

function atomicWriteSettings(settingsFile, settings) {
  const dir = path.dirname(settingsFile);
  const temporaryFile = path.join(
    dir,
    `.${path.basename(settingsFile)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  let operationError;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    fs.renameSync(temporaryFile, settingsFile);
  } catch (error) {
    operationError = error;
  }

  try {
    fs.unlinkSync(temporaryFile);
  } catch (error) {
    if (error.code !== 'ENOENT' && !operationError) operationError = error;
  }
  if (operationError) throw operationError;
}

function acquireSettingsLock(settingsFile, lockfilePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return lockfile.lockSync(settingsFile, {
        lockfilePath,
        realpath: false,
        stale: SETTINGS_LOCK_STALE_MS,
      });
    } catch (error) {
      if (error.code !== 'ELOCKED' || Date.now() >= deadline) throw error;
      Atomics.wait(SETTINGS_LOCK_SLEEP, 0, 0, SETTINGS_LOCK_RETRY_MS);
    }
  }
}

/**
 * Atomically mutate global settings under the process-shared settings lock.
 * The mutator receives only the freshly re-read, normalized state.
 *
 * @param {(settings: object) => any} mutator
 * @param {object} [options]
 * @returns {any} the mutator's return value
 */
function mutateSettings(mutator, options = {}) {
  if (typeof mutator !== 'function') {
    throw new TypeError('Global settings mutation requires a callback');
  }

  const settingsFile = getSettingsFile();
  const dir = path.dirname(settingsFile);
  const lockfilePath = `${settingsFile}.lock`;
  let release;
  let result;
  let mutationError;

  try {
    fs.mkdirSync(dir, { recursive: true });
    release = acquireSettingsLock(
      settingsFile,
      lockfilePath,
      options.lockTimeoutMs ?? SETTINGS_LOCK_TIMEOUT_MS
    );

    const { settings, requiresClaimInvalidation, requiresRecovery } =
      readSettingsForMutation(settingsFile);
    const before = JSON.stringify(settings);
    result = mutator(settings);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Global settings mutations must be synchronous');
    }
    if (settings.autoCheckUpdates === false || settings.updatePolicy === 'off') {
      settings.lastUpdateCheckClaim = null;
    }
    if (requiresRecovery || requiresClaimInvalidation || JSON.stringify(settings) !== before) {
      atomicWriteSettings(settingsFile, settings);
    }
  } catch (error) {
    mutationError =
      error instanceof SettingsValidationError
        ? error
        : new Error(`Unable to persist global settings: ${error.message}`, { cause: error });
  } finally {
    if (release) {
      try {
        release();
      } catch (error) {
        if (!mutationError) {
          mutationError = new Error(`Unable to release global settings lock: ${error.message}`, {
            cause: error,
          });
        }
      }
    }
  }
  if (mutationError) throw mutationError;
  return result;
}

/**
 * Validate claudeCommand setting
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateClaudeCommand(value) {
  if (typeof value !== 'string') {
    return 'claudeCommand must be a string';
  }
  if (value.trim().length === 0) {
    return 'claudeCommand cannot be empty';
  }
  return null;
}

/**
 * Validate providerSettings structure by delegating to provider implementations
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateProviderSettings(value) {
  const normalizedSettings = normalizeProviderSettings(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'providerSettings must be an object';
  }

  // Lazy require to avoid circular dependency
  const { getProvider } = require('../src/providers');

  for (const [providerName, settings] of Object.entries(normalizedSettings || {})) {
    if (!VALID_PROVIDERS.includes(providerName)) {
      return `Unknown provider in providerSettings: ${providerName}. Valid providers: ${VALID_PROVIDERS.join(', ')}`;
    }

    // Delegate validation to the provider
    try {
      const provider = getProvider(providerName);
      const error = provider.validateSettings(settings);
      if (error) return error;
    } catch (err) {
      return `Failed to validate ${providerName} settings: ${err.message}`;
    }
  }

  return null;
}

/**
 * Validate a setting value
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) {
    return `Unknown setting: ${key}`;
  }

  if (
    [
      'maxRetries',
      'maxRestartAttempts',
      'maxTotalRestarts',
      'staleWarningsBeforeKill',
      'backoffBaseMs',
      'backoffMaxMs',
    ].includes(key)
  ) {
    if (!Number.isFinite(value)) {
      return `${key} must be a number`;
    }
    if (!Number.isInteger(value)) {
      return `${key} must be an integer`;
    }
    const min = ['backoffBaseMs', 'backoffMaxMs'].includes(key) ? 0 : 1;
    if (value < min) {
      return `${key} must be >= ${min}`;
    }
  }

  if (key === 'jitterFactor') {
    if (!Number.isFinite(value)) {
      return 'jitterFactor must be a number';
    }
    if (value < 0 || value > 1) {
      return 'jitterFactor must be between 0 and 1';
    }
  }

  if (key === 'maxModel' && !VALID_MODELS.includes(value)) {
    return `Invalid model: ${value}. Valid models: ${VALID_MODELS.join(', ')}`;
  }

  if (key === 'minModel' && value !== null && !VALID_MODELS.includes(value)) {
    return `Invalid model: ${value}. Valid models: ${VALID_MODELS.join(', ')}, null`;
  }

  if (key === 'logLevel' && !['quiet', 'normal', 'verbose'].includes(value)) {
    return `Invalid log level: ${value}. Valid levels: quiet, normal, verbose`;
  }

  if (key === 'defaultDelivery' && !['none', 'pr', 'ship'].includes(value)) {
    return `Invalid defaultDelivery: ${value}. Valid: none, pr, ship`;
  }

  if (key === 'claudeCommand') {
    return validateClaudeCommand(value);
  }

  if (key === 'defaultProvider') {
    const normalized = normalizeProviderName(value);
    if (!VALID_PROVIDERS.includes(normalized)) {
      return `Invalid provider: ${value}. Valid providers: ${VALID_PROVIDERS.join(', ')}`;
    }
  }

  if (key === 'providerSettings') {
    return validateProviderSettings(value);
  }

  if (key === 'dockerMounts') {
    return validateMountConfig(value);
  }

  if (key === 'dockerEnvPassthrough') {
    return validateEnvPassthrough(value);
  }

  // Issue source settings validation (grouped for maintainability)
  const issueSourceError = validateIssueSourceSetting(key, value);
  if (issueSourceError !== undefined) {
    return issueSourceError;
  }

  return null;
}

/**
 * Validate issue source related settings
 * Delegates to issue providers for provider-specific settings
 * @param {string} key - Setting key
 * @param {any} value - Setting value
 * @returns {string|null|undefined} Error message, null if valid, undefined if not an issue source setting
 */
function validateIssueSourceSetting(key, value) {
  // defaultIssueSource is handled here (not provider-specific)
  if (key === 'defaultIssueSource') {
    const { listProviders } = getIssueProviderFns();
    const validSources = listProviders();
    if (!validSources.includes(value)) {
      return `Invalid issue source: ${value}. Valid: ${validSources.join(', ')}`;
    }
    return null;
  }

  // Delegate to issue providers for provider-specific settings
  const { validateIssueProviderSetting } = getIssueProviderFns();
  return validateIssueProviderSetting(key, value);
}

/**
 * Coerce value to correct type based on default value type
 */
function coerceValue(key, value) {
  const defaultValue = DEFAULT_SETTINGS[key];

  // Handle null values for minModel
  if (key === 'minModel' && (value === 'null' || value === null)) {
    return null;
  }

  if (typeof defaultValue === 'boolean') {
    return value === 'true' || value === '1' || value === 'yes' || value === true;
  }

  if (typeof defaultValue === 'number') {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      throw new Error(`Invalid number: ${value}`);
    }
    return parsed;
  }

  // Handle array settings (dockerMounts, dockerEnvPassthrough)
  if (Array.isArray(defaultValue)) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          throw new Error(`${key} must be an array`);
        }
        return parsed;
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`Invalid JSON for ${key}: ${value}`);
        }
        throw e;
      }
    }
    return value;
  }

  if (key === 'providerSettings') {
    if (typeof value === 'string') {
      try {
        return normalizeProviderSettings(JSON.parse(value));
      } catch {
        throw new Error(`Invalid JSON for providerSettings: ${value}`);
      }
    }
    return normalizeProviderSettings(value);
  }

  if (key === 'defaultProvider') {
    return normalizeProviderName(value);
  }

  return value;
}

/**
 * Get parsed Claude command from settings/env
 * Supports space-separated commands like 'ccr code'
 * @returns {{ command: string, args: string[] }}
 */
function getClaudeCommand() {
  const settings = loadSettings();
  const raw = process.env.ZEROSHOT_CLAUDE_COMMAND || settings.claudeCommand || 'claude';
  const parts = raw.trim().split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

module.exports = {
  loadSettings,
  mutateSettings,
  validateSetting,
  coerceValue,
  SettingsValidationError,
  DEFAULT_SETTINGS,
  getSettingsFile,
  settingsFileExists,
  getClaudeCommand,
  // Model validation exports
  MODEL_HIERARCHY,
  VALID_MODELS,
  validateModelAgainstMax,
  // Provider defaults exports
  clearProviderDefaultsCache,
  mapLegacyModelToLevel,
  // Backward compatibility: SETTINGS_FILE as getter (reads env var dynamically)
  get SETTINGS_FILE() {
    return getSettingsFile();
  },
};
