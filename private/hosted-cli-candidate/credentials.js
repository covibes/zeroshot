'use strict';

const path = require('node:path');
const { readRuntimeConfig, resolveHostedRuntime } = require('./runtime-config');

const MAX_RUNTIME_BUNDLE_BYTES = 4 * 1024 * 1024;
const BASE_REVISION = /^[0-9a-f]{40}$/;

function repositoryBinding(repository) {
  const [owner, name, extra] = typeof repository === 'string' ? repository.split('/') : [];
  const validOwner = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner ?? '');
  const validName = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9._])?$/.test(name ?? '');
  if (!validOwner || !validName || extra !== undefined || name.endsWith('.git')) {
    throw new Error('repository must be one canonical lowercase GitHub owner/name');
  }
  return `github.com/${repository}`;
}

function normalizeRepository(repository) {
  repositoryBinding(repository);
  return repository;
}

function normalizeBaseRevision(baseRevision) {
  if (typeof baseRevision !== 'string' || !BASE_REVISION.test(baseRevision)) {
    throw new Error('base revision must be one lowercase 40-character commit');
  }
  return baseRevision;
}

function normalizeRuntimeConfigPath(runtimeConfigPath) {
  if (typeof runtimeConfigPath !== 'string' || !runtimeConfigPath.trim()) {
    throw new Error('runtime config path must be a nonempty string');
  }
  const resolved = path.resolve(runtimeConfigPath);
  readRuntimeConfig(resolved);
  return resolved;
}

function getSetup(target) {
  const setup = target?.hostedSetup;
  if (
    !setup ||
    setup.kind !== 'zeroshot.private-hosted-setup/v2' ||
    typeof setup.repository !== 'string' ||
    typeof setup.baseRevision !== 'string' ||
    typeof setup.runtimeConfigPath !== 'string' ||
    !path.isAbsolute(setup.runtimeConfigPath)
  ) {
    throw new Error('target setup is missing; run `zeroshot target setup` first');
  }
  normalizeRepository(setup.repository);
  normalizeBaseRevision(setup.baseRevision);
  return setup;
}

function configureTargetSetup(options) {
  const {
    targetName,
    target,
    repository,
    baseRevision,
    runtimeConfigPath,
    settings,
    clock = Date,
  } = options;
  const normalizedRepository = normalizeRepository(repository);
  const metadata = Object.freeze({
    kind: 'zeroshot.private-hosted-setup/v2',
    repository: normalizedRepository,
    baseRevision: normalizeBaseRevision(baseRevision),
    runtimeConfigPath: normalizeRuntimeConfigPath(runtimeConfigPath),
    configuredAt: new Date(clock.now()).toISOString(),
  });
  settings.mutate((state) => {
    const current = state._targets?.[targetName];
    if (!current || current.id !== target.id)
      throw new Error(`Target "${targetName}" changed during setup`);
    state._targets[targetName] = { ...current, hostedSetup: metadata };
  });
  return metadata;
}

function checkHostedSetup(target) {
  return getSetup(target);
}

function githubToken(environment = process.env) {
  const configured = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  if (configured?.trim()) return configured.trim();
  throw new Error('hosted runs require GH_TOKEN or GITHUB_TOKEN');
}

function resolveRuntimeBundle(target, environment = process.env) {
  const setup = getSetup(target);
  const runtime = readRuntimeConfig(setup.runtimeConfigPath);
  const bundle = {
    githubToken: githubToken(environment),
    repository: setup.repository,
    baseRevision: setup.baseRevision,
    runtime: resolveHostedRuntime(runtime, environment),
  };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_RUNTIME_BUNDLE_BYTES) {
    throw new Error('hosted runtime bundle exceeds 4 MiB');
  }
  return bundle;
}

module.exports = {
  checkHostedSetup,
  configureTargetSetup,
  getSetup,
  repositoryBinding,
  resolveRuntimeBundle,
};
