'use strict';

const path = require('node:path');
const {
  DELIVERY_CONTRACT_VERSION,
  normalizeDeliveryRequest,
} = require('../../lib/delivery-contract');
const { readRuntimeConfig, resolveHostedRuntime } = require('./runtime-config');

const MAX_RUNTIME_BUNDLE_BYTES = 4 * 1024 * 1024;
const BASE_REVISION = /^[0-9a-f]{40}$/;
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;

function repositoryBinding(repository) {
  try {
    normalizeDeliveryRequest({
      version: DELIVERY_CONTRACT_VERSION,
      mode: 'pr',
      repository,
      targetBranch: 'main',
      baseRevision: '0'.repeat(40),
    });
  } catch {
    throw new Error('repository must be one canonical lowercase GitHub owner/name');
  }
  return `github.com/${repository}`;
}

function normalizeRepository(repository) {
  repositoryBinding(repository);
  return repository;
}

function normalizeBaseSelector(base, targetBranch) {
  if (base === undefined) {
    if (targetBranch !== undefined)
      throw new Error('--target-branch requires an exact commit base');
    return Object.freeze({ kind: 'default' });
  }
  if (typeof base !== 'string' || !base.trim()) throw new Error('base must be a branch or commit');
  if (BASE_REVISION.test(base)) {
    if (targetBranch === undefined) {
      throw new Error('an exact commit base requires --target-branch for pr or ship delivery');
    }
    const normalized = normalizeDeliveryRequest({
      version: DELIVERY_CONTRACT_VERSION,
      mode: 'pr',
      repository: 'runtime-owned/repository',
      targetBranch,
      baseRevision: base,
    });
    return Object.freeze({
      kind: 'commit',
      revision: base,
      targetBranch: normalized.targetBranch,
    });
  }
  if (targetBranch !== undefined)
    throw new Error('--target-branch is only valid with an exact commit');
  const normalized = normalizeDeliveryRequest({
    version: DELIVERY_CONTRACT_VERSION,
    mode: 'pr',
    repository: 'runtime-owned/repository',
    targetBranch: base,
    baseRevision: '0'.repeat(40),
  });
  return Object.freeze({ kind: 'branch', branch: normalized.targetBranch });
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
    setup.kind !== 'zeroshot.private-hosted-setup/v3' ||
    typeof setup.repository !== 'string' ||
    !setup.base ||
    typeof setup.runtimeConfigPath !== 'string' ||
    !path.isAbsolute(setup.runtimeConfigPath)
  ) {
    throw new Error('target setup is missing; run `zeroshot target setup` first');
  }
  normalizeRepository(setup.repository);
  const normalizedBase = normalizeStoredBase(setup.base);
  if (JSON.stringify(normalizedBase) !== JSON.stringify(setup.base)) {
    throw new Error('target setup is invalid; run `zeroshot target setup` again');
  }
  return setup;
}

function normalizeStoredBase(base) {
  if (base.kind === 'default') return normalizeBaseSelector(undefined, undefined);
  if (base.kind === 'branch') return normalizeBaseSelector(base.branch, undefined);
  return normalizeBaseSelector(base.revision, base.targetBranch);
}

function configureTargetSetup(options) {
  const {
    targetName,
    target,
    repository,
    base,
    targetBranch,
    runtimeConfigPath,
    settings,
    clock = Date,
  } = options;
  const normalizedRepository = normalizeRepository(repository);
  const metadata = Object.freeze({
    kind: 'zeroshot.private-hosted-setup/v3',
    repository: normalizedRepository,
    base: normalizeBaseSelector(base, targetBranch),
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

async function boundedGithubJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.length === 0 || bytes.length > MAX_GITHUB_RESPONSE_BYTES) {
    throw new Error('GitHub rejected hosted submission base resolution');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub returned invalid hosted submission metadata');
  }
  return value;
}

async function githubMetadata(repository, route, token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}${route}`, {
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'zeroshot-private-hosted-candidate',
      'x-github-api-version': '2022-11-28',
    },
  });
  return boundedGithubJson(response);
}

async function resolveSubmissionBase(setup, token, fetchImpl = globalThis.fetch) {
  let targetBranch;
  let baseRevision;
  if (setup.base.kind === 'default') {
    const repository = await githubMetadata(setup.repository, '', token, fetchImpl);
    targetBranch = repository.default_branch;
  } else if (setup.base.kind === 'branch') {
    targetBranch = setup.base.branch;
  } else {
    targetBranch = setup.base.targetBranch;
    const commit = await githubMetadata(
      setup.repository,
      `/commits/${setup.base.revision}`,
      token,
      fetchImpl
    );
    if (commit.sha !== setup.base.revision)
      throw new Error('GitHub did not resolve the exact commit');
    baseRevision = setup.base.revision;
  }
  if (baseRevision === undefined) {
    const ref = await githubMetadata(
      setup.repository,
      `/git/ref/heads/${encodeURIComponent(targetBranch)}`,
      token,
      fetchImpl
    );
    baseRevision = ref.object?.sha;
  }
  return { targetBranch, baseRevision };
}

async function resolveRuntimeBundle(target, options = {}) {
  const setup = getSetup(target);
  const runtime = readRuntimeConfig(setup.runtimeConfigPath);
  const environment = options.environment ?? process.env;
  const token = githubToken(environment);
  const submission = await resolveSubmissionBase(setup, token, options.fetch);
  const delivery = normalizeDeliveryRequest({
    version: DELIVERY_CONTRACT_VERSION,
    mode: options.mode,
    repository: setup.repository,
    ...submission,
  });
  const bundle = {
    githubToken: token,
    repository: setup.repository,
    baseRevision: delivery.baseRevision,
    delivery,
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
  resolveSubmissionBase,
  resolveRuntimeBundle,
};
