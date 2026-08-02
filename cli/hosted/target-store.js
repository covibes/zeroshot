'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function targetsFile(environment = process.env) {
  return environment.ZEROSHOT_TARGETS_FILE || path.join(os.homedir(), '.zeroshot', 'targets.json');
}

function normalizeTargetName(name) {
  if (!TARGET_NAME.test(name)) {
    throw new Error('target name must match [a-z][a-z0-9-]{0,31}');
  }
  return name;
}

function normalizeEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('target endpoint must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !['', '/'].includes(endpoint.pathname)
  ) {
    throw new Error('target endpoint must be an HTTP(S) origin without credentials or a path');
  }
  return endpoint.origin;
}

function emptyStore() {
  return { version: 1, targets: {} };
}

function loadTargets(environment = process.env) {
  const filename = targetsFile(environment);
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, flags);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    if (error.code === 'ELOOP') {
      throw new Error(`target store is not a regular file: ${filename}`);
    }
    throw error;
  }
  let contents;
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(filename);
    if (
      !descriptorStat.isFile() ||
      pathStat.isSymbolicLink() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      throw new Error(`target store is not a regular file: ${filename}`);
    }
    contents = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`target store is not valid JSON: ${filename}`);
  }
  if (
    parsed?.version !== 1 ||
    !parsed.targets ||
    typeof parsed.targets !== 'object' ||
    Array.isArray(parsed.targets)
  ) {
    throw new Error(`target store has an unsupported shape: ${filename}`);
  }
  const targets = {};
  for (const [name, target] of Object.entries(parsed.targets)) {
    targets[normalizeTargetName(name)] = { endpoint: normalizeEndpoint(target?.endpoint) };
  }
  return { version: 1, targets };
}

function saveTargets(store, environment = process.env) {
  const filename = targetsFile(environment);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function addTarget(name, endpoint, environment = process.env) {
  const targetName = normalizeTargetName(name);
  const store = loadTargets(environment);
  store.targets[targetName] = { endpoint: normalizeEndpoint(endpoint) };
  saveTargets(store, environment);
  return store.targets[targetName];
}

function getTarget(name, environment = process.env) {
  const targetName = normalizeTargetName(name);
  const target = loadTargets(environment).targets[targetName];
  if (!target) throw new Error(`unknown target: ${targetName}`);
  return target;
}

function removeTarget(name, environment = process.env) {
  const targetName = normalizeTargetName(name);
  const store = loadTargets(environment);
  if (!store.targets[targetName]) throw new Error(`unknown target: ${targetName}`);
  delete store.targets[targetName];
  saveTargets(store, environment);
}

module.exports = {
  addTarget,
  getTarget,
  loadTargets,
  normalizeEndpoint,
  normalizeTargetName,
  removeTarget,
  targetsFile,
};
