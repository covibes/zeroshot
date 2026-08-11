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

function assertRuntimeOutputs() {
  assertDockerConfigOutput();
  assertStartClusterOutput();
}

module.exports = { assertRuntimeOutputs };
