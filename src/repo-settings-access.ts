interface RepoSettingsResult {
  settings?: unknown;
}

interface RepoSettingsModule {
  readRepoSettings(startDir: string): RepoSettingsResult;
}

interface PropertySelectionOptions {
  skipUndefined?: boolean;
}

function isRepoSettingsModule(value: unknown): value is RepoSettingsModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readRepoSettings' in value &&
    typeof value.readRepoSettings === 'function'
  );
}

const repoSettingsModule: unknown = require('../lib/repo-settings');
if (!isRepoSettingsModule(repoSettingsModule)) {
  throw new TypeError('repo-settings must export readRepoSettings');
}
const readRepoSettings = repoSettingsModule.readRepoSettings;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function propertyValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function selectOwnProperty(
  key: string,
  candidates: readonly unknown[],
  options: PropertySelectionOptions = {}
): unknown {
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(candidate || {}, key)) {
      continue;
    }

    const value = propertyValue(candidate, key);
    if (options.skipUndefined && value === undefined) {
      continue;
    }
    return value;
  }
  return undefined;
}

function readRepoSettingsValue(startDir: string): unknown {
  return readRepoSettings(startDir).settings || {};
}

export = {
  isRecord,
  propertyValue,
  readRepoSettingsValue,
  selectOwnProperty,
};
