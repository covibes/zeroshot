'use strict';

const { MAX_SECRET_BYTES, PromptInput, spawnBounded, trimmedSecret } = require('./secret-input');
const { defaultGithub } = require('./github-credential');

const PROVIDER = 'codex-openrouter';
const PROFILE = 'provider.codex-openrouter-pr@1';
const MODEL = 'openai/gpt-5.2-codex';

function repositoryBinding(repository) {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(
      repository
    ) ||
    repository.endsWith('.git')
  ) {
    throw new Error('repository must be one canonical GitHub owner/name');
  }
  return `github.com/${repository}`;
}

function openRouterService(targetId) {
  return `zeroshot-hosted-provider-${targetId}`;
}

function openRouterAccount() {
  return `openrouter:${PROFILE}`;
}

function getSetup(target) {
  const setup = target?.hostedSetup;
  if (
    !setup ||
    setup.kind !== 'zeroshot.private-hosted-setup/v1' ||
    setup.provider !== PROVIDER ||
    setup.profile !== PROFILE ||
    setup.model !== MODEL ||
    typeof setup.repository !== 'string' ||
    setup.github?.source !== 'gh-cli' ||
    setup.openrouter?.source !== 'os-keyring'
  ) {
    throw new Error('target setup is missing; run `zeroshot target setup` first');
  }
  return setup;
}

async function configureTargetSetup(options) {
  const {
    targetName,
    target,
    repository,
    provider,
    settings,
    credentialStore,
    github = defaultGithub,
    prompt = new PromptInput(process.stdin, process.stderr),
    clock = Date,
  } = options;
  if (provider !== PROVIDER) throw new Error(`provider must be exactly ${PROVIDER}`);
  const boundRepository = repositoryBinding(repository);
  const githubMetadata = await github.inspect();
  const consent = await prompt.line(
    `Use GitHub CLI account ${githubMetadata.account} for ${boundRepository}? [yes/no] `,
    { maxBytes: 8 }
  );
  let openRouterSecret;
  try {
    const answer = consent.toString('utf8').trim().toLowerCase();
    if (answer !== 'yes') throw new Error('GitHub CLI token use requires explicit consent');
    if (typeof github.acquire !== 'function') {
      throw new Error('GitHub credential source does not support atomic acquisition');
    }
    const service = openRouterService(target.id);
    const account = openRouterAccount();
    const existing = await credentialStore.get(service, account);
    if (existing === null) {
      const entered = await prompt.line('OpenRouter API key: ', { secret: true });
      try {
        openRouterSecret = trimmedSecret(entered, 'OpenRouter key');
      } finally {
        entered.fill(0);
      }
      await credentialStore.set(service, account, openRouterSecret.toString('utf8'));
    } else {
      openRouterSecret = Buffer.from(existing, 'utf8');
      if (openRouterSecret.length === 0 || openRouterSecret.length > MAX_SECRET_BYTES) {
        throw new Error('Stored OpenRouter key is outside the safety bound');
      }
    }

    const metadata = Object.freeze({
      kind: 'zeroshot.private-hosted-setup/v1',
      repository: boundRepository,
      provider: PROVIDER,
      profile: PROFILE,
      model: MODEL,
      github: Object.freeze(githubMetadata),
      openrouter: Object.freeze({ source: 'os-keyring', service, account }),
      configuredAt: new Date(clock.now()).toISOString(),
    });
    settings.mutate((state) => {
      const current = state._targets?.[targetName];
      if (!current || current.id !== target.id)
        throw new Error(`Target "${targetName}" changed during setup`);
      state._targets[targetName] = { ...current, hostedSetup: metadata };
    });
    return metadata;
  } finally {
    consent.fill(0);
    openRouterSecret?.fill(0);
    prompt.clear?.();
  }
}

async function checkCredentialSources(target, credentialStore, github = defaultGithub) {
  const setup = getSetup(target);
  const metadata = await github.inspect();
  if (metadata.host !== setup.github.host || metadata.account !== setup.github.account) {
    throw new Error('The active GitHub CLI account no longer matches target setup');
  }
  const stored = await credentialStore.get(setup.openrouter.service, setup.openrouter.account);
  if (stored === null)
    throw new Error('The target/profile OpenRouter key is missing from the OS keyring');
  const probe = Buffer.from(stored, 'utf8');
  try {
    if (probe.length === 0 || probe.length > MAX_SECRET_BYTES) {
      throw new Error('The target/profile OpenRouter key is outside the safety bound');
    }
  } finally {
    probe.fill(0);
  }
  return setup;
}

async function readInstallCredentials(target, credentialStore, github = defaultGithub) {
  const setup = getSetup(target);
  const acquired = await github.acquire();
  const githubToken = acquired?.token;
  let openrouter;
  try {
    if (
      acquired?.metadata?.host !== setup.github.host ||
      acquired?.metadata?.account !== setup.github.account
    ) {
      throw new Error('The acquired GitHub credential does not match target setup');
    }
    if (
      !Buffer.isBuffer(githubToken) ||
      githubToken.length === 0 ||
      githubToken.length > MAX_SECRET_BYTES
    ) {
      throw new Error('GitHub CLI token is outside the safety bound');
    }
    const stored = await credentialStore.get(setup.openrouter.service, setup.openrouter.account);
    if (stored === null)
      throw new Error('The target/profile OpenRouter key is missing from the OS keyring');
    openrouter = Buffer.from(stored, 'utf8');
    if (openrouter.length === 0 || openrouter.length > MAX_SECRET_BYTES) {
      throw new Error('The target/profile OpenRouter key is outside the safety bound');
    }
    return { githubToken, openrouterKey: openrouter };
  } catch (error) {
    githubToken?.fill(0);
    openrouter?.fill(0);
    throw error;
  }
}

module.exports = {
  MAX_SECRET_BYTES,
  MODEL,
  PROFILE,
  PROVIDER,
  PromptInput,
  checkCredentialSources,
  configureTargetSetup,
  defaultGithub,
  getSetup,
  openRouterAccount,
  openRouterService,
  readInstallCredentials,
  repositoryBinding,
  spawnBounded,
};
