interface SettingsRecord extends Record<string, unknown> {
  claudeCommand?: string;
}

interface StorageFacade {
  loadSettings(options?: { silent?: unknown }): SettingsRecord;
  mutateSettings(
    mutator: (settings: SettingsRecord) => unknown,
    options?: { lockTimeoutMs?: number }
  ): unknown;
  getSettingsFile(): string;
  settingsFileExists(): boolean;
}

interface ValidationFacade {
  validateSetting(key: string, value: unknown): string | null;
  coerceValue(key: string, value: unknown): unknown;
}

interface ModelsFacade {
  MODEL_HIERARCHY: Readonly<Record<string, number>>;
  VALID_MODELS: readonly string[];
  validateModelAgainstMax(
    requestedModel: string | null | undefined,
    maxModel: string,
    minModel?: string | null
  ): string;
  mapLegacyModelToLevel(model: unknown): 'level1' | 'level2' | 'level3' | null;
}

interface DefaultsFacade {
  DEFAULT_SETTINGS: SettingsRecord;
}

interface ProviderDefaultsFacade {
  clearProviderDefaultsCache(): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const storage: StorageFacade = require('./settings-storage');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const validation: ValidationFacade = require('./settings-validation');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const models: ModelsFacade = require('./settings-models');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const defaults: DefaultsFacade = require('./settings-defaults');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerDefaults: ProviderDefaultsFacade = require('./provider-defaults');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { SettingsValidationError }: { SettingsValidationError: typeof Error } =
  require('./settings-error');

const { loadSettings, mutateSettings, getSettingsFile, settingsFileExists } = storage;
const { validateSetting, coerceValue } = validation;
const { MODEL_HIERARCHY, VALID_MODELS, validateModelAgainstMax, mapLegacyModelToLevel } = models;
const { DEFAULT_SETTINGS } = defaults;
const { clearProviderDefaultsCache } = providerDefaults;

function getClaudeCommand(): { command: string | undefined; args: string[] } {
  const settings = loadSettings();
  const raw = process.env.ZEROSHOT_CLAUDE_COMMAND || settings.claudeCommand || 'claude';
  const parts = raw.trim().split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export = {
  loadSettings,
  mutateSettings,
  validateSetting,
  coerceValue,
  SettingsValidationError,
  DEFAULT_SETTINGS,
  getSettingsFile,
  settingsFileExists,
  getClaudeCommand,
  MODEL_HIERARCHY,
  VALID_MODELS,
  validateModelAgainstMax,
  clearProviderDefaultsCache,
  mapLegacyModelToLevel,
  get SETTINGS_FILE(): string {
    return getSettingsFile();
  },
};
