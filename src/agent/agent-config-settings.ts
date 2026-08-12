interface SettingsRecord extends Record<string, unknown> {
  maxModel: string;
  minModel?: string | null;
  strictSchema?: boolean;
}

interface SettingsFacade {
  loadSettings(): SettingsRecord;
  validateModelAgainstMax(
    requestedModel: string | null | undefined,
    maxModel: string,
    minModel?: string | null
  ): string;
  VALID_MODELS: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSettingsFacade(value: unknown): value is SettingsFacade {
  return (
    isRecord(value) &&
    typeof value.loadSettings === 'function' &&
    typeof value.validateModelAgainstMax === 'function' &&
    isStringArray(value.VALID_MODELS)
  );
}

const rawSettings: unknown = require('../../lib/settings');
if (!isSettingsFacade(rawSettings)) {
  throw new TypeError('settings module must expose model validation');
}

const verifiedSettings: SettingsFacade = rawSettings;

export = verifiedSettings;
