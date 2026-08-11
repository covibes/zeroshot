/**
 * Provider defaults module
 *
 * Separated from settings.js to break circular dependency:
 * - settings.js requires provider defaults
 * - providers require settings.js (for loadSettings, getClaudeCommand, etc.)
 *
 * CRITICAL: This module should NOT import from settings.js
 */

interface ProviderDefaultSettings {
  defaultLevel?: string;
  levelOverrides?: Record<string, string>;
  maxLevel?: string;
  minLevel?: string;
  [key: string]: unknown;
}

interface ProviderMetadata {
  defaultLevels: {
    default: string;
    max: string;
    min: string;
  };
}

interface ProviderNamesFacade {
  VALID_PROVIDERS: readonly string[];
  getProviderMetadata(name: string): ProviderMetadata;
}

interface ProviderFacade {
  getDefaultSettings(): ProviderDefaultSettings;
}

interface ProvidersFacade {
  getProvider(name: string): ProviderFacade;
  listProviders(): string[];
}

type ProviderDefaults = Record<string, ProviderDefaultSettings>;

// Cache provider defaults to avoid repeated instantiation
let _providerDefaultsCache: ProviderDefaults | null = null;
// The emitted CommonJS module resolves this maintained JavaScript facade from lib/.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { VALID_PROVIDERS, getProviderMetadata }: ProviderNamesFacade = require('./provider-names');

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return undefined;
  }
  return typeof error.message === 'string' ? error.message : String(error.message);
}

/**
 * Build provider default settings by instantiating each provider
 * and calling getDefaultSettings()
 */
function buildProviderDefaults(): ProviderDefaults {
  // Keep this require lazy to preserve the settings/provider circular-dependency boundary.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { listProviders, getProvider }: ProvidersFacade = require('../src/providers');

  const defaults: ProviderDefaults = {};
  for (const providerName of listProviders()) {
    try {
      const provider = getProvider(providerName);
      defaults[providerName] = provider.getDefaultSettings();
    } catch (error: unknown) {
      const metadata = getProviderMetadata(providerName);
      console.warn(`Warning: Could not get defaults for ${providerName}: ${errorMessage(error)}`);
      defaults[providerName] = {
        maxLevel: metadata.defaultLevels.max,
        minLevel: metadata.defaultLevels.min,
        defaultLevel: metadata.defaultLevels.default,
        levelOverrides: {},
      };
    }
  }
  for (const providerName of VALID_PROVIDERS) {
    if (defaults[providerName]) continue;
    const metadata = getProviderMetadata(providerName);
    defaults[providerName] = {
      maxLevel: metadata.defaultLevels.max,
      minLevel: metadata.defaultLevels.min,
      defaultLevel: metadata.defaultLevels.default,
      levelOverrides: {},
    };
  }
  return defaults;
}

/**
 * Get or build cached provider defaults
 */
function getProviderDefaults(): ProviderDefaults {
  if (!_providerDefaultsCache) {
    _providerDefaultsCache = buildProviderDefaults();
  }
  return _providerDefaultsCache;
}

/**
 * Clear the provider defaults cache (primarily for testing)
 */
function clearProviderDefaultsCache(): void {
  _providerDefaultsCache = null;
}

export = {
  getProviderDefaults,
  clearProviderDefaultsCache,
};
