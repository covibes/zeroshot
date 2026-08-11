const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');

function assertDockerConfigOutput() {
  const dockerConfigPath = path.join(repoRoot, 'lib/docker-config.js');
  assert.ok(
    fs.existsSync(dockerConfigPath),
    'legacy TypeScript build must emit lib/docker-config.js'
  );
  const dockerConfig = require(dockerConfigPath);
  assert.deepStrictEqual(Reflect.ownKeys(dockerConfig), [
    'MOUNT_PRESETS',
    'ENV_PRESETS',
    'PROVIDER_ENV_ONLY_PRESETS',
    'resolveMounts',
    'resolveEnvs',
    'expandEnvPatterns',
    'isUsableEnvValue',
    'isUsableHttpUrl',
    'validateMountConfig',
    'validateEnvPassthrough',
    'validateProviderEnvAuth',
  ]);
}

function assertStartClusterOutput() {
  const startClusterPath = path.join(repoRoot, 'lib/start-cluster.js');
  assert.ok(
    fs.existsSync(startClusterPath),
    'legacy TypeScript build must emit lib/start-cluster.js'
  );
  const startCluster = require(startClusterPath);
  assert.deepStrictEqual(Reflect.ownKeys(startCluster), [
    'buildTextInput',
    'buildIssueInput',
    'buildFileInput',
    'detectRunInput',
    'isStdinInput',
    'readStdinText',
    'encodeStdinEnv',
    'decodeStdinEnv',
    'resolveProviderOverride',
    'resolveConfigPath',
    'prepareClusterConfig',
    'loadClusterConfig',
    'buildStartOptions',
    'buildTrustedStartOptions',
    'resolveEffectiveRunPlan',
    'startClusterFromText',
    'startClusterFromIssue',
    'startClusterFromFile',
    'detectGitRepoRoot',
  ]);
}

function assertSettingsOutput() {
  const settingsPath = path.join(repoRoot, 'lib/settings.js');
  assert.ok(fs.existsSync(settingsPath), 'legacy TypeScript build must emit lib/settings.js');
  const settings = require(settingsPath);
  assert.deepStrictEqual(Reflect.ownKeys(settings), [
    'loadSettings',
    'mutateSettings',
    'validateSetting',
    'coerceValue',
    'SettingsValidationError',
    'DEFAULT_SETTINGS',
    'getSettingsFile',
    'settingsFileExists',
    'getClaudeCommand',
    'MODEL_HIERARCHY',
    'VALID_MODELS',
    'validateModelAgainstMax',
    'clearProviderDefaultsCache',
    'mapLegacyModelToLevel',
    'SETTINGS_FILE',
  ]);
}

function assertRuntimeOutputs() {
  assertDockerConfigOutput();
  assertStartClusterOutput();
  assertSettingsOutput();
}

module.exports = { assertRuntimeOutputs };
