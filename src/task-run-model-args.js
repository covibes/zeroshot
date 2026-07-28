/**
 * Append a resolved model selection to a nested `zeroshot task run` invocation.
 *
 * Direct requests use the public, catalog-strict `--model` channel.
 * Provider-level selections carry only their level. The child must resolve the
 * concrete model again from its effective provider settings.
 *
 * @param {string[]} args
 * @param {Object|null|undefined} modelSpec
 * @param {'direct'|'provider-level'} [modelSpecSource]
 * @returns {string[]}
 */
function appendTaskRunModelArgs(args, modelSpec, modelSpecSource = 'direct') {
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

/**
 * Wrap an isolated task command with a Docker-only, temporary settings-file
 * bootstrap. The snapshot is a closed projection containing only the selected
 * OpenCode level and its model. It never contains arbitrary provider settings,
 * credentials, or caller-owned keys.
 *
 * @param {string[]} command
 * @param {{providerName: string, settings: Object, modelSpecSource: 'direct'|'provider-level', modelSpec: Object|null|undefined}} context
 * @returns {string[]}
 */
function wrapTaskRunWithIsolatedSettings(command, context) {
  const { providerName, settings, modelSpecSource, modelSpec } = context;
  if (providerName !== 'opencode' || modelSpecSource !== 'provider-level') return command;
  const snapshot = buildIsolatedSettingsSnapshot(settings, modelSpec);
  if (snapshot === null) return command;
  return ['node', '-e', SETTINGS_BOOTSTRAP_SCRIPT, snapshot, ...command];
}

function buildIsolatedSettingsSnapshot(settings, modelSpec) {
  const level = modelSpec?.level;
  if (!['level1', 'level2', 'level3'].includes(level)) {
    throw permanentError(
      'Provider-level isolated OpenCode selections require a valid model level.'
    );
  }

  const providerSettings = ownRecordValue(settings, 'providerSettings', 'settings') ?? {};
  const opencodeSettings = ownRecordValue(
    providerSettings,
    'opencode',
    'settings.providerSettings'
  );
  const levelOverrides = ownRecordValue(
    opencodeSettings,
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
      `Provider-level model "${modelSpec?.model}" does not match the effective isolated ${modelSpec?.level} model "${configuredModel}".`
    );
  }
  if (configuredModel === null) return null;

  return JSON.stringify({
    providerSettings: {
      opencode: {
        levelOverrides: {
          [level]: { model: configuredModel },
        },
      },
    },
  });
}

function ownRecordValue(record, key, field) {
  if (record === null || record === undefined) return undefined;
  if (typeof record !== 'object' || Array.isArray(record)) {
    throw permanentError(`${field} must be an object.`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw permanentError(`${field}.${key} must be an object.`);
  }
  return value;
}

function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

module.exports = {
  ISOLATED_SETTINGS_FILE_ENV,
  ISOLATED_SETTINGS_FILE_MARKER,
  LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV,
  appendTaskRunModelArgs,
  wrapTaskRunWithIsolatedSettings,
};
