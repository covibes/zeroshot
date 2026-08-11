'use strict';

const fs = require('node:fs');
const { getProviderRegistryEntry } = require('../../lib/agent-cli-provider');
const { normalizeDeliveryRequest } = require('../../lib/delivery-contract');
const { assertDeclarativeClusterConfig } = require('./declarative-cluster');

const REPOSITORY_ENV = 'ZEROSHOT_HOSTED_REPOSITORY';
const BASE_REVISION_ENV = 'ZEROSHOT_HOSTED_BASE_REVISION';
const DELIVERY_MODE_ENV = 'ZEROSHOT_HOSTED_DELIVERY_MODE';
const DELIVERY_TARGET_ENV = 'ZEROSHOT_HOSTED_DELIVERY_TARGET';
const DELIVERY_VERSION_ENV = 'ZEROSHOT_HOSTED_DELIVERY_VERSION';
const EXECUTABLE_ENV = 'ZEROSHOT_HOSTED_EXECUTABLE';
const EXECUTABLE_ROOT_ENV = 'ZEROSHOT_HOSTED_EXEC_ROOT';
const PROVIDER_ENV = 'ZEROSHOT_HOSTED_PROVIDER';
const MODEL_ENV = 'ZEROSHOT_HOSTED_MODEL';
const SETTINGS_ENV = 'ZEROSHOT_SETTINGS_FILE';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_CLUSTER_BYTES = 512 * 1024;
const CLUSTER_CONFIG_FILE = '/tmp/zeroshot-oecp/runtime/cluster.json';
const CONTROL_ENVIRONMENT = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'LANG',
  'NODE_ENV',
  'PATH',
  'TMPDIR',
  BASE_REVISION_ENV,
  DELIVERY_MODE_ENV,
  DELIVERY_TARGET_ENV,
  DELIVERY_VERSION_ENV,
  EXECUTABLE_ENV,
  EXECUTABLE_ROOT_ENV,
  MODEL_ENV,
  PROVIDER_ENV,
  REPOSITORY_ENV,
  'ZEROSHOT_ISOLATION_PROFILE',
  'ZEROSHOT_PROVIDER_PROFILE',
  SETTINGS_ENV,
]);

class HostedConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostedConfigError';
    this.code = 'HOSTED_CONFIGURATION_INVALID';
  }
}

function invalidConfiguration() {
  return new HostedConfigError('Hosted runtime configuration is invalid');
}

function required(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== 'string' || !pattern.test(value)) throw invalidConfiguration();
  return value;
}

function readBoundedJsonFile(filename, maximumBytes, allowMissing = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) throw invalidConfiguration();
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    if (error instanceof HostedConfigError) throw error;
    throw invalidConfiguration();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readSettingsFile(filename) {
  const settings = readBoundedJsonFile(filename, MAX_SETTINGS_BYTES);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw invalidConfiguration();
  }
  return Object.freeze(settings);
}

function readClusterConfig(filename = CLUSTER_CONFIG_FILE) {
  try {
    const config = readBoundedJsonFile(filename, MAX_CLUSTER_BYTES, true);
    if (config === null) return null;
    return assertDeclarativeClusterConfig(config);
  } catch {
    throw invalidConfiguration();
  }
}

function runtimeSettings(environment) {
  const filename = environment[SETTINGS_ENV];
  if (typeof filename !== 'string' || !filename.startsWith('/')) throw invalidConfiguration();
  return readSettingsFile(filename);
}

function selectedRuntimeEnvironment(environment) {
  const entries = Object.entries(environment).filter(([name, value]) => {
    if (CONTROL_ENVIRONMENT.has(name)) return false;
    if (typeof value !== 'string') throw invalidConfiguration();
    return true;
  });
  return Object.freeze(Object.fromEntries(entries));
}

function validRepositoryAuthority(repository) {
  const [owner, name] = repository.split('/');
  return owner !== '.' && owner !== '..' && name !== '.' && name !== '..' && !name.endsWith('.git');
}

function optionalModel(environment) {
  const model = environment[MODEL_ENV];
  if (model === undefined) return undefined;
  if (typeof model !== 'string' || model.trim().length === 0 || Buffer.byteLength(model) > 512) {
    throw invalidConfiguration();
  }
  return model;
}

function loadInstalledHostedWorkerConfiguration(environment = process.env, options = {}) {
  const repository = required(environment, REPOSITORY_ENV, REPOSITORY);
  if (!validRepositoryAuthority(repository)) throw invalidConfiguration();
  const baseRevision = required(environment, BASE_REVISION_ENV, REVISION);
  const executable = required(environment, EXECUTABLE_ENV, IDENTIFIER);
  let registeredExecutable;
  try {
    registeredExecutable = getProviderRegistryEntry(executable).id;
  } catch {
    throw invalidConfiguration();
  }
  if (registeredExecutable !== executable) throw invalidConfiguration();
  const provider = required(environment, PROVIDER_ENV, IDENTIFIER);
  const model = optionalModel(environment);
  const clusterConfig = readClusterConfig(options.clusterConfigFile);
  let delivery;
  try {
    delivery = normalizeDeliveryRequest({
      version: required(environment, DELIVERY_VERSION_ENV, /^zeroshot\.delivery\/v1$/),
      mode: required(environment, DELIVERY_MODE_ENV, /^(?:pr|ship)$/),
      repository,
      targetBranch: required(environment, DELIVERY_TARGET_ENV, /^.{1,255}$/),
      baseRevision,
    });
  } catch {
    throw invalidConfiguration();
  }
  return Object.freeze({
    repository,
    baseRevision,
    executable: registeredExecutable,
    provider,
    ...(model === undefined ? {} : { model }),
    runtimeEnvironment: selectedRuntimeEnvironment(environment),
    settings: runtimeSettings(environment),
    cluster: clusterConfig
      ? Object.freeze({ config: clusterConfig })
      : Object.freeze({ configName: 'conductor-bootstrap' }),
    delivery,
  });
}

module.exports = {
  HostedConfigError,
  readClusterConfig,
  loadInstalledHostedWorkerConfiguration,
};
