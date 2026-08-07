'use strict';

const fs = require('node:fs');

const REPOSITORY_ENV = 'ZEROSHOT_HOSTED_REPOSITORY';
const BASE_REVISION_ENV = 'ZEROSHOT_HOSTED_BASE_REVISION';
const EXECUTABLE_ENV = 'ZEROSHOT_HOSTED_EXECUTABLE';
const EXECUTABLE_ROOT_ENV = 'ZEROSHOT_HOSTED_EXEC_ROOT';
const PROVIDER_ENV = 'ZEROSHOT_HOSTED_PROVIDER';
const MODEL_ENV = 'ZEROSHOT_HOSTED_MODEL';
const SETTINGS_ENV = 'ZEROSHOT_SETTINGS_FILE';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SETTINGS_BYTES = 1024 * 1024;
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

function readSettingsFile(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) throw invalidConfiguration();
    const settings = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw invalidConfiguration();
    }
    return Object.freeze(settings);
  } catch (error) {
    if (error instanceof HostedConfigError) throw error;
    throw invalidConfiguration();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
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

function loadInstalledHostedWorkerConfiguration(environment = process.env) {
  const repository = required(environment, REPOSITORY_ENV, REPOSITORY);
  if (!validRepositoryAuthority(repository)) throw invalidConfiguration();
  const baseRevision = required(environment, BASE_REVISION_ENV, REVISION);
  const executable = required(environment, EXECUTABLE_ENV, IDENTIFIER);
  const provider = required(environment, PROVIDER_ENV, IDENTIFIER);
  const model = optionalModel(environment);
  return Object.freeze({
    repository,
    baseRevision,
    executable,
    provider,
    ...(model === undefined ? {} : { model }),
    runtimeEnvironment: selectedRuntimeEnvironment(environment),
    settings: runtimeSettings(environment),
  });
}

module.exports = {
  HostedConfigError,
  loadInstalledHostedWorkerConfiguration,
};
