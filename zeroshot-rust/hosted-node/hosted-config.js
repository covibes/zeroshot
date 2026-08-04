'use strict';

const {
  credentialEnvKeysForProvider,
  findProviderRegistryEntry,
  listProviderRegistryEntries,
} = require('../../lib/agent-cli-provider/provider-registry');

const CREDENTIALS_ENV = 'ZEROSHOT_HOSTED_CREDENTIALS_JSON';
const REPOSITORY_ENV = 'ZEROSHOT_HOSTED_REPOSITORY';
const BASE_REVISION_ENV = 'ZEROSHOT_HOSTED_BASE_REVISION';
const PROVIDER_ENV = 'ZEROSHOT_HOSTED_PROVIDER';
const MODEL_LEVEL_ENV = 'ZEROSHOT_HOSTED_MODEL_LEVEL';
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_CREDENTIAL_ENTRIES = 32;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const REVISION = /^[0-9a-f]{40}$/;
const MODEL_LEVELS = new Set(['level1', 'level2', 'level3']);

const KNOWN_CREDENTIAL_KEYS = new Set(['GH_TOKEN']);
for (const entry of listProviderRegistryEntries()) {
  for (const key of entry.credentialEnvKeys) KNOWN_CREDENTIAL_KEYS.add(key);
}

class HostedConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostedConfigError';
    this.code = code;
  }
}

function invalidCredentials() {
  return new HostedConfigError(
    'HOSTED_CREDENTIALS_INVALID',
    'Hosted credential configuration is invalid'
  );
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

function parseJsonString(source, start) {
  if (source[start] !== '"') throw invalidCredentials();
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const token = source.slice(start, index + 1);
      let value;
      try {
        value = JSON.parse(token);
      } catch {
        throw invalidCredentials();
      }
      if (typeof value !== 'string') throw invalidCredentials();
      return { value, next: index + 1 };
    }
    if (character === '\\') {
      index += 1;
      if (index >= source.length) throw invalidCredentials();
      if (source[index] === 'u') {
        const escape = source.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(escape)) throw invalidCredentials();
        index += 4;
      } else if (!'"\\/bfnrt'.includes(source[index])) {
        throw invalidCredentials();
      }
    } else if (character.charCodeAt(0) <= 0x1f) {
      throw invalidCredentials();
    }
    index += 1;
  }
  throw invalidCredentials();
}

function parseCredentialObject(source, knownKeys) {
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') throw invalidCredentials();
  index = skipWhitespace(source, index + 1);
  const entries = new Map();
  if (source[index] === '}') index += 1;
  else {
    for (;;) {
      const keyToken = parseJsonString(source, index);
      const key = keyToken.value;
      index = skipWhitespace(source, keyToken.next);
      if (source[index] !== ':') throw invalidCredentials();
      index = skipWhitespace(source, index + 1);
      const valueToken = parseJsonString(source, index);
      const value = valueToken.value;
      if (
        entries.has(key) ||
        entries.size >= MAX_CREDENTIAL_ENTRIES ||
        !CREDENTIAL_NAME.test(key) ||
        !knownKeys.has(key) ||
        value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_VALUE_BYTES
      ) {
        throw invalidCredentials();
      }
      entries.set(key, value);
      index = skipWhitespace(source, valueToken.next);
      if (source[index] === '}') {
        index += 1;
        break;
      }
      if (source[index] !== ',') throw invalidCredentials();
      index = skipWhitespace(source, index + 1);
    }
  }
  if (skipWhitespace(source, index) !== source.length) throw invalidCredentials();
  return entries;
}

function requiredSelector(environment, name, valid) {
  const value = environment[name];
  if (typeof value !== 'string' || !valid(value)) {
    throw new HostedConfigError(
      'HOSTED_CONFIGURATION_INVALID',
      'Hosted runtime configuration is invalid'
    );
  }
  return value;
}

function fixedSelectors(environment) {
  const repository = requiredSelector(
    environment,
    REPOSITORY_ENV,
    (value) => REPOSITORY.test(value) && !value.endsWith('.git')
  );
  const baseRevision = requiredSelector(environment, BASE_REVISION_ENV, (value) =>
    REVISION.test(value)
  );
  const provider = requiredSelector(environment, PROVIDER_ENV, (value) => {
    const entry = findProviderRegistryEntry(value);
    return entry !== undefined && entry.id === value;
  });
  const modelLevel = requiredSelector(environment, MODEL_LEVEL_ENV, (value) =>
    MODEL_LEVELS.has(value)
  );
  return { repository, baseRevision, provider, modelLevel };
}

function rejectUnsupportedHostedProvider(provider) {
  if (provider === 'gateway') {
    throw new HostedConfigError(
      'HOSTED_PROVIDER_CREDENTIAL_UNSUPPORTED',
      'Selected hosted provider requires unavailable trusted settings'
    );
  }
}

function selectedCredentialEnvironment(provider, credentials) {
  const gitToken = credentials.get('GH_TOKEN');
  if (gitToken === undefined) {
    throw new HostedConfigError(
      'HOSTED_GIT_CREDENTIAL_MISSING',
      'Hosted Git credential is unavailable'
    );
  }
  const providerKeys = credentialEnvKeysForProvider(provider);
  if (providerKeys.length === 0) {
    throw new HostedConfigError(
      'HOSTED_PROVIDER_CREDENTIAL_UNSUPPORTED',
      'Selected hosted provider has no environment credential contract'
    );
  }
  const configuredProviderKeys = providerKeys.filter((key) => credentials.has(key));
  if (configuredProviderKeys.length === 0) {
    throw new HostedConfigError(
      'HOSTED_PROVIDER_CREDENTIAL_MISSING',
      'Selected hosted provider credential is unavailable'
    );
  }
  const workerEnvironment = { GH_TOKEN: gitToken };
  for (const key of configuredProviderKeys) workerEnvironment[key] = credentials.get(key);
  return Object.freeze(workerEnvironment);
}

function loadHostedWorkerConfiguration(environment = process.env) {
  const selectors = fixedSelectors(environment);
  rejectUnsupportedHostedProvider(selectors.provider);
  const encodedCredentials = environment[CREDENTIALS_ENV];
  if (encodedCredentials === undefined) {
    throw new HostedConfigError(
      'HOSTED_CREDENTIALS_MISSING',
      'Hosted credential configuration is unavailable'
    );
  }
  if (
    typeof encodedCredentials !== 'string' ||
    encodedCredentials.length === 0 ||
    Buffer.byteLength(encodedCredentials, 'utf8') > MAX_CREDENTIAL_BYTES
  ) {
    throw invalidCredentials();
  }

  const credentials = parseCredentialObject(encodedCredentials, KNOWN_CREDENTIAL_KEYS);
  return Object.freeze({
    ...selectors,
    workerEnvironment: selectedCredentialEnvironment(selectors.provider, credentials),
  });
}

function loadInstalledHostedWorkerConfiguration(environment = process.env) {
  const selectors = fixedSelectors(environment);
  rejectUnsupportedHostedProvider(selectors.provider);
  const credentials = new Map();
  for (const key of KNOWN_CREDENTIAL_KEYS) {
    const value = environment[key];
    if (typeof value === 'string' && value.length > 0) credentials.set(key, value);
  }
  return Object.freeze({
    ...selectors,
    workerEnvironment: selectedCredentialEnvironment(selectors.provider, credentials),
  });
}

function removeCredentialBundle(environment = process.env) {
  delete environment[CREDENTIALS_ENV];
}

function installHostedWorkerConfiguration(environment = process.env) {
  const configuration = loadHostedWorkerConfiguration(environment);
  for (const key of KNOWN_CREDENTIAL_KEYS) delete environment[key];
  removeCredentialBundle(environment);
  Object.assign(environment, configuration.workerEnvironment);
  return configuration;
}

module.exports = {
  CREDENTIALS_ENV,
  HostedConfigError,
  installHostedWorkerConfiguration,
  loadInstalledHostedWorkerConfiguration,
  loadHostedWorkerConfiguration,
  removeCredentialBundle,
};
