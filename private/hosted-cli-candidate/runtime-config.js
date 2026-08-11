'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SETTINGS_RUNTIME_PATH = 'settings.json';
const RESERVED_ENVIRONMENT = new Set([
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
  'ZEROSHOT_HOSTED_BASE_REVISION',
  'ZEROSHOT_HOSTED_DELIVERY_MODE',
  'ZEROSHOT_HOSTED_DELIVERY_TARGET',
  'ZEROSHOT_HOSTED_DELIVERY_VERSION',
  'ZEROSHOT_HOSTED_EXECUTABLE',
  'ZEROSHOT_HOSTED_EXEC_ROOT',
  'ZEROSHOT_HOSTED_MODEL',
  'ZEROSHOT_HOSTED_PROVIDER',
  'ZEROSHOT_HOSTED_REPOSITORY',
  'ZEROSHOT_ISOLATION_PROFILE',
  'ZEROSHOT_PROVIDER_PROFILE',
  'ZEROSHOT_SETTINGS_FILE',
]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const RUNTIME_FIELDS = new Set([
  'provider',
  'executable',
  'model',
  'command',
  'setupCommand',
  'environment',
  'files',
  'settings',
]);

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function boundedString(value, field, maximum, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) {
    throw new Error(`${field} must be a nonempty string of at most ${maximum} bytes`);
  }
  return value;
}

function boundedIdentifier(value, field, maximum, optional = false) {
  const normalized = boundedString(value, field, maximum, optional);
  if (normalized === undefined) return undefined;
  if (!IDENTIFIER.test(normalized)) {
    throw new Error(`${field} must be a bounded identifier`);
  }
  return normalized;
}

function normalizeSource(value, field) {
  if (typeof value === 'string') return value;
  const source = record(value, field);
  if (
    Object.keys(source).length !== 1 ||
    typeof source.from !== 'string' ||
    !source.from.trim() ||
    Buffer.byteLength(source.from) > 4096
  ) {
    throw new Error(`${field} must be a string or a bounded {"from":"..."}`);
  }
  return { from: source.from };
}

function validRuntimePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\')) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    !path.posix.isAbsolute(value) &&
    value !== SETTINGS_RUNTIME_PATH &&
    !value.startsWith(`${SETTINGS_RUNTIME_PATH}/`) &&
    !value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  );
}

function normalizeEnvironment(value) {
  const environment = value === undefined ? {} : record(value, 'runtime environment');
  if (Object.keys(environment).length > 256) {
    throw new Error('runtime environment exceeds 256 entries');
  }
  const entries = [];
  for (const [name, source] of Object.entries(environment)) {
    if (name.length > 256 || !ENVIRONMENT_NAME.test(name)) {
      throw new Error(`invalid runtime environment variable name: ${name}`);
    }
    if (RESERVED_ENVIRONMENT.has(name)) {
      throw new Error(`runtime environment variable is reserved: ${name}`);
    }
    const normalized = normalizeSource(source, `runtime environment.${name}`);
    if (typeof normalized === 'string' && Buffer.byteLength(normalized) > 64 * 1024) {
      throw new Error(`runtime environment.${name} exceeds 64 KiB`);
    }
    entries.push([name, normalized]);
  }
  return Object.fromEntries(entries);
}

function normalizeFiles(value) {
  const files = value === undefined ? {} : record(value, 'runtime files');
  if (Object.keys(files).length > 128) throw new Error('runtime files exceeds 128 entries');
  const entries = [];
  for (const [filename, source] of Object.entries(files)) {
    if (!validRuntimePath(filename)) {
      throw new Error(`invalid runtime file path: ${filename}`);
    }
    const normalized = normalizeSource(source, `runtime files.${filename}`);
    if (typeof normalized === 'string' && Buffer.byteLength(normalized) > MAX_FILE_BYTES) {
      throw new Error(`runtime file exceeds 512 KiB: ${filename}`);
    }
    entries.push([filename, normalized]);
  }
  return Object.fromEntries(entries);
}

function normalizeRuntimeConfig(value) {
  const input = record(value, 'runtime config');
  const unknown = Object.keys(input).filter((field) => !RUNTIME_FIELDS.has(field));
  if (unknown.length) throw new Error(`unknown runtime config field: ${unknown.join(', ')}`);

  const provider = boundedIdentifier(input.provider, 'runtime provider', 64);
  const requestedExecutable =
    boundedIdentifier(input.executable, 'runtime executable', 128, true) ?? provider;
  const { getProviderRegistryEntry } = require('../../lib/agent-cli-provider');
  const executable = getProviderRegistryEntry(requestedExecutable).id;
  const model = boundedString(input.model, 'runtime model', 512, true);
  const command = boundedString(input.command, 'runtime command', 4096, true);
  const setupCommand = boundedString(input.setupCommand, 'runtime setupCommand', 16 * 1024, true);
  const settings =
    input.settings === undefined
      ? {}
      : JSON.parse(JSON.stringify(record(input.settings, 'runtime settings')));
  return {
    provider,
    executable,
    ...(model === undefined ? {} : { model }),
    ...(command === undefined ? {} : { command }),
    ...(setupCommand === undefined ? {} : { setupCommand }),
    environment: normalizeEnvironment(input.environment),
    files: normalizeFiles(input.files),
    settings,
  };
}

function readRuntimeConfig(filename, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, filename);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`runtime config is not a regular file: ${resolved}`);
    if (stat.size > MAX_CONFIG_BYTES) throw new Error('runtime config exceeds 1 MiB');
    const runtime = normalizeRuntimeConfig(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
    for (const source of Object.values(runtime.files)) {
      if (
        typeof source !== 'string' &&
        source.from !== '~' &&
        !source.from.startsWith('~/') &&
        !path.isAbsolute(source.from)
      ) {
        source.from = path.resolve(path.dirname(resolved), source.from);
      }
    }
    return runtime;
  } finally {
    fs.closeSync(descriptor);
  }
}

function expandSourcePath(filename) {
  if (filename === '~') return os.homedir();
  if (filename.startsWith('~/')) return path.join(os.homedir(), filename.slice(2));
  return path.resolve(filename);
}

function readRuntimeTextFile(filename) {
  const sourcePath = expandSourcePath(filename);
  const descriptor = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`runtime file source is not regular: ${sourcePath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`runtime file exceeds 512 KiB: ${sourcePath}`);
    const contents = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
      throw new Error(`runtime file exceeds 512 KiB after text decoding: ${sourcePath}`);
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveEnvironment(environment, hostEnvironment) {
  const entries = [];
  for (const [name, source] of Object.entries(environment)) {
    if (typeof source === 'string') {
      entries.push([name, source]);
      continue;
    }
    const value = hostEnvironment[source.from];
    if (value === undefined) {
      throw new Error(`runtime environment ${name} requires local ${source.from}`);
    }
    if (Buffer.byteLength(value) > 64 * 1024) {
      throw new Error(`runtime environment.${name} exceeds 64 KiB`);
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function resolveFiles(files) {
  const entries = [];
  let total = 0;
  for (const [filename, source] of Object.entries(files)) {
    let contents;
    if (typeof source === 'string') {
      contents = source;
    } else {
      contents = readRuntimeTextFile(source.from);
    }
    total += Buffer.byteLength(contents);
    if (total > MAX_CONFIG_BYTES) throw new Error('runtime files exceed 1 MiB in total');
    entries.push([filename, contents]);
  }
  return Object.fromEntries(entries);
}

function withRuntimeFile(runtime, filename, contents) {
  if (!validRuntimePath(filename)) throw new Error(`invalid runtime file path: ${filename}`);
  if (typeof contents !== 'string' || Buffer.byteLength(contents) > MAX_FILE_BYTES) {
    throw new Error(`runtime file exceeds 512 KiB: ${filename}`);
  }
  const files = { ...runtime.files, [filename]: contents };
  if (Object.keys(files).length > 128) throw new Error('runtime files exceeds 128 entries');
  const total = Object.values(files).reduce((bytes, value) => bytes + Buffer.byteLength(value), 0);
  if (total > MAX_CONFIG_BYTES) throw new Error('runtime files exceed 1 MiB in total');
  return { ...runtime, files };
}

function resolveHostedRuntime(targetRuntime, hostEnvironment = process.env) {
  const runtime = normalizeRuntimeConfig(targetRuntime);
  return {
    ...runtime,
    environment: resolveEnvironment(runtime.environment, hostEnvironment),
    files: resolveFiles(runtime.files),
  };
}

module.exports = {
  normalizeRuntimeConfig,
  readRuntimeTextFile,
  readRuntimeConfig,
  resolveHostedRuntime,
  withRuntimeFile,
};
