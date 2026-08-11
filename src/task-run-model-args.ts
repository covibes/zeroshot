type ModelSpecSource = 'direct' | 'provider-level';
type ModelLevel = 'level1' | 'level2' | 'level3';
type UnknownRecord = Record<string, unknown>;

interface ProviderNamesModule {
  providerSupportsCapability(providerName: string, capability: string): boolean;
}

interface ModelSpec {
  level?: ModelLevel;
  model?: string | null;
  reasoningEffort?: string;
}

interface IsolatedSettingsContext {
  providerName: string;
  settings: unknown;
  modelSpecSource: ModelSpecSource;
  modelSpec: ModelSpec | null | undefined;
}

interface IsolatedProviderSnapshot {
  webSearch?: true;
  levelOverrides?: Partial<Record<ModelLevel, { model: string }>>;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderNamesModule(value: unknown): value is ProviderNamesModule {
  return isUnknownRecord(value) && typeof value.providerSupportsCapability === 'function';
}

const providerNames: unknown = require('../lib/provider-names');
if (!isProviderNamesModule(providerNames)) {
  throw new TypeError('provider-names must expose provider capability lookup');
}
const { providerSupportsCapability } = providerNames;

function appendTaskRunModelArgs(
  args: string[],
  modelSpec: ModelSpec | null | undefined,
  modelSpecSource: ModelSpecSource = 'direct'
): string[] {
  if (modelSpecSource === 'provider-level') {
    if (!modelSpec?.level) {
      throw new Error('Provider-level task model selections require a model level');
    }
    args.push('--model-level', modelSpec.level);
  } else if (modelSpec?.model) {
    args.push('--model', modelSpec.model);
  }

  if (modelSpec?.reasoningEffort) {
    args.push('--reasoning-effort', modelSpec.reasoningEffort);
  }

  return args;
}

const ISOLATED_SETTINGS_FILE_ENV = 'ZEROSHOT_SETTINGS_FILE';
const ISOLATED_SETTINGS_FILE_MARKER = 'ZEROSHOT_DOCKER_SETTINGS_FILE';
const LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV = 'ZEROSHOT_ISOLATED_PROVIDER_SETTINGS_JSON';
const SETTINGS_BOOTSTRAP_SCRIPT = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snapshot = process.argv[1];
const command = process.argv[2];
const args = process.argv.slice(3);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-isolated-settings-'));
const settingsFile = path.join(directory, 'settings.json');

try {
  fs.writeFileSync(settingsFile, snapshot, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const result = childProcess.spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ${ISOLATED_SETTINGS_FILE_ENV}: settingsFile,
      ${ISOLATED_SETTINGS_FILE_MARKER}: '1',
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
`.trim();

function wrapTaskRunWithIsolatedSettings(
  command: string[],
  context: IsolatedSettingsContext
): string[] {
  const { providerName, settings, modelSpecSource, modelSpec } = context;
  if (!providerSupportsCapability(providerName, 'webSearch')) return command;
  const includesOpencodeModel =
    providerName === 'opencode' && modelSpecSource === 'provider-level';
  const snapshot = buildIsolatedSettingsSnapshot(
    settings,
    providerName,
    includesOpencodeModel ? modelSpec : null
  );
  if (snapshot === null) return command;
  return ['node', '-e', SETTINGS_BOOTSTRAP_SCRIPT, snapshot, ...command];
}

function buildIsolatedSettingsSnapshot(
  settings: unknown,
  providerName: string,
  opencodeModelSpec: ModelSpec | null | undefined
): string | null {
  const providerSettings = ownRecordValue(settings, 'providerSettings', 'settings') ?? {};
  const selectedSettings = ownRecordValue(
    providerSettings,
    providerName,
    'settings.providerSettings'
  );
  const webSearch = selectedSettings?.webSearch;
  if (webSearch !== undefined && typeof webSearch !== 'boolean') {
    throw permanentError(`settings.providerSettings.${providerName}.webSearch must be a boolean.`);
  }

  const snapshot: IsolatedProviderSnapshot = {};
  if (webSearch === true) snapshot.webSearch = true;
  if (opencodeModelSpec !== null) {
    const levelOverrides = resolveIsolatedOpenCodeOverrides(selectedSettings, opencodeModelSpec);
    if (levelOverrides !== undefined) snapshot.levelOverrides = levelOverrides;
  }

  if (Object.keys(snapshot).length === 0) return null;
  return JSON.stringify({
    providerSettings: {
      [providerName]: snapshot,
    },
  });
}


function resolveIsolatedOpenCodeOverrides(
  selectedSettings: UnknownRecord | undefined,
  modelSpec: ModelSpec | undefined
): IsolatedProviderSnapshot['levelOverrides'] {
  const level = modelSpec?.level;
  if (level !== 'level1' && level !== 'level2' && level !== 'level3') {
    throw permanentError(
      'Provider-level isolated OpenCode selections require a valid model level.'
    );
  }

  const levelOverrides = ownRecordValue(
    selectedSettings,
    'levelOverrides',
    'settings.providerSettings.opencode'
  );
  const levelOverride = ownRecordValue(
    levelOverrides,
    level,
    'settings.providerSettings.opencode.levelOverrides'
  );
  const configuredModel =
    levelOverride && Object.prototype.hasOwnProperty.call(levelOverride, 'model')
      ? levelOverride.model
      : null;
  if (configuredModel !== null && typeof configuredModel !== 'string') {
    throw permanentError(`Configured isolated OpenCode ${level} model must be a string or null.`);
  }
  if (modelSpec?.model !== configuredModel) {
    throw permanentError(
      `Provider-level model "${modelSpec?.model}" does not match ` +
        `the effective isolated ${level} model "${configuredModel}".`
    );
  }
  return configuredModel === null ? undefined : { [level]: { model: configuredModel } };
}

function ownRecordValue(record: unknown, key: string, field: string): UnknownRecord | undefined {
  if (record === null || record === undefined) return undefined;
  if (!isUnknownRecord(record)) {
    throw permanentError(`${field} must be an object.`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (value === null || value === undefined) return undefined;
  if (!isUnknownRecord(value)) {
    throw permanentError(`${field}.${key} must be an object.`);
  }
  return value;
}

function permanentError(message: string): Error & { permanent: true } {
  return Object.assign(new Error(message), { permanent: true as const });
}

export = {
  ISOLATED_SETTINGS_FILE_ENV,
  ISOLATED_SETTINGS_FILE_MARKER,
  LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV,
  appendTaskRunModelArgs,
  wrapTaskRunWithIsolatedSettings,
};
