'use strict';

const FORBIDDEN_KEYS = new Set([
  'configPath',
  'cwd',
  'loadConfig',
  'plugin',
  'plugins',
  'promptFile',
  'promptPath',
  'script',
  'taskExecutor',
]);
const FORBIDDEN_ACTIONS = new Set(['execute_system_command', 'load_config']);
const MAX_DECLARATIVE_DEPTH = 32;

function invalid(path, reason) {
  throw new Error(`Hosted cluster config ${path} ${reason}`);
}

function requireRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
}

function validateHookFields(hook, path) {
  for (const name of Object.keys(hook)) {
    if (name !== 'action' && name !== 'config') invalid(`${path}.${name}`, 'is not declarative');
  }
}

function validateHooks(value, path) {
  requireRecord(value, path);
  for (const name of Object.keys(value)) {
    if (name !== 'onComplete') invalid(`${path}.${name}`, 'is not declarative');
  }
  const hook = value.onComplete;
  if (!hook) return;
  requireRecord(hook, `${path}.onComplete`);
  if (hook.action !== 'publish_message') {
    invalid(`${path}.onComplete.action`, 'must be publish_message');
  }
  validateHookFields(hook, `${path}.onComplete`);
}

function walk(value, path, depth) {
  if (depth > MAX_DECLARATIVE_DEPTH) invalid(path, 'exceeds the declarative depth bound');
  if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    const childPath = `${path}.${name}`;
    if (FORBIDDEN_KEYS.has(name)) invalid(childPath, 'is not allowed');
    if (name === 'action' && FORBIDDEN_ACTIONS.has(child)) {
      invalid(childPath, 'is not declarative');
    }
    if (name === 'hooks') validateHooks(child, childPath);
    walk(child, childPath, depth + 1);
  }
}

function assertDeclarativeClusterConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    invalid('$', 'must be an object');
  }
  if (Object.hasOwn(config, 'base') || Object.hasOwn(config, 'params')) {
    invalid('$', 'cannot load parameterized templates');
  }
  walk(config, '$', 0);
  return config;
}

module.exports = { assertDeclarativeClusterConfig };
