'use strict';

const PROVIDER = 'codex';
const MODEL_LEVEL = 'level2';

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

function getSetup(target) {
  const setup = target?.hostedSetup;
  if (
    !setup ||
    setup.kind !== 'zeroshot.private-hosted-setup/v1' ||
    setup.provider !== PROVIDER ||
    setup.modelLevel !== MODEL_LEVEL ||
    typeof setup.repository !== 'string'
  ) {
    throw new Error('target setup is missing; run `zeroshot target setup` first');
  }
  normalizeRepository(setup.repository);
  return setup;
}

async function configureTargetSetup(options) {
  const { targetName, target, repository, provider, modelLevel, settings, clock = Date } = options;
  if (provider !== PROVIDER) throw new Error(`provider must be exactly ${PROVIDER}`);
  if (modelLevel !== MODEL_LEVEL) throw new Error(`model level must be exactly ${MODEL_LEVEL}`);
  const normalizedRepository = normalizeRepository(repository);
  const metadata = Object.freeze({
    kind: 'zeroshot.private-hosted-setup/v1',
    repository: normalizedRepository,
    provider: PROVIDER,
    modelLevel: MODEL_LEVEL,
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

module.exports = {
  MODEL_LEVEL,
  PROVIDER,
  checkHostedSetup,
  configureTargetSetup,
  getSetup,
  repositoryBinding,
};
