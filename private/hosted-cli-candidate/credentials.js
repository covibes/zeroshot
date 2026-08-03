'use strict';

const { spawn } = require('node:child_process');

const PROVIDER = 'codex-openrouter';
const PROFILE = 'provider.codex-openrouter-pr@1';
const MODEL = 'openai/gpt-5.2-codex';
const MAX_SECRET_BYTES = 4096;
const MAX_GH_OUTPUT_BYTES = 32 * 1024;

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

function spawnBounded(command, args, maxBytes = MAX_GH_OUTPUT_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const collect = (chunks, isStdout) => (chunk) => {
      const copy = Buffer.from(chunk);
      if (isStdout) stdoutBytes += copy.length;
      else stderrBytes += copy.length;
      if (stdoutBytes + stderrBytes > maxBytes) {
        overflow = true;
        copy.fill(0);
        child.kill('SIGKILL');
        return;
      }
      chunks.push(copy);
    };
    child.stdout.on('data', collect(stdout, true));
    child.stderr.on('data', collect(stderr, false));
    child.once('error', (error) =>
      reject(new Error(`${command} is unavailable`, { cause: error }))
    );
    child.once('close', (code) => {
      const out = Buffer.concat(stdout, stdoutBytes);
      const err = Buffer.concat(stderr, stderrBytes);
      for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      if (overflow) {
        out.fill(0);
        err.fill(0);
        reject(new Error(`${command} output exceeded the safety bound`));
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function trimmedSecret(buffer, label) {
  let start = 0;
  let end = buffer.length;
  while (
    start < end &&
    (buffer[start] === 0x20 ||
      buffer[start] === 0x09 ||
      buffer[start] === 0x0a ||
      buffer[start] === 0x0d)
  )
    start += 1;
  while (
    end > start &&
    (buffer[end - 1] === 0x20 ||
      buffer[end - 1] === 0x09 ||
      buffer[end - 1] === 0x0a ||
      buffer[end - 1] === 0x0d)
  )
    end -= 1;
  if (end === start || end - start > MAX_SECRET_BYTES)
    throw new Error(`${label} is empty or exceeds the safety bound`);
  return Buffer.from(buffer.subarray(start, end));
}

const defaultGithub = Object.freeze({
  async inspect() {
    const result = await spawnBounded('gh', [
      'auth',
      'status',
      '--hostname',
      'github.com',
      '--json',
      'active,host,login',
    ]);
    try {
      if (result.code !== 0) throw new Error('GitHub CLI is not authenticated for github.com');
      const value = JSON.parse(result.stdout.toString('utf8'));
      const entry = Array.isArray(value) ? value.find((item) => item?.active === true) : value;
      if (
        !entry ||
        entry.active !== true ||
        entry.host !== 'github.com' ||
        typeof entry.login !== 'string'
      ) {
        throw new Error('GitHub CLI has no active github.com account');
      }
      return Object.freeze({ source: 'gh-cli', host: 'github.com', account: entry.login });
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error('GitHub CLI returned invalid account metadata');
      throw error;
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  },
  async readToken() {
    const result = await spawnBounded('gh', ['auth', 'token', '--hostname', 'github.com']);
    try {
      if (result.code !== 0) throw new Error('GitHub CLI could not provide its github.com token');
      return trimmedSecret(result.stdout, 'GitHub token');
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  },
});

class PromptInput {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.iterator = input[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
  }

  async line(prompt, { secret = false, maxBytes = MAX_SECRET_BYTES } = {}) {
    this.output.write(prompt);
    if (secret && this.input.isTTY && typeof this.input.setRawMode === 'function') {
      return this.#rawSecret(maxBytes);
    }
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline !== -1) {
        const line = Buffer.from(this.pending.subarray(0, newline));
        const rest = Buffer.from(this.pending.subarray(newline + 1));
        this.pending.fill(0);
        this.pending = rest;
        if (line.length > maxBytes) {
          line.fill(0);
          throw new Error('stdin value exceeded the safety bound');
        }
        return line;
      }
      const next = await this.iterator.next();
      if (next.done) {
        if (this.pending.length === 0) throw new Error('stdin ended before the required value');
        const line = this.pending;
        this.pending = Buffer.alloc(0);
        return line;
      }
      const chunk = Buffer.from(next.value);
      if (this.pending.length + chunk.length > MAX_SECRET_BYTES * 2 + 32) {
        chunk.fill(0);
        this.pending.fill(0);
        this.pending = Buffer.alloc(0);
        throw new Error('stdin exceeded the setup safety bound');
      }
      const combined = Buffer.concat([this.pending, chunk]);
      this.pending.fill(0);
      chunk.fill(0);
      this.pending = combined;
    }
  }

  async #rawSecret(maxBytes) {
    const value = Buffer.alloc(maxBytes);
    let length = 0;
    const wasRaw = Boolean(this.input.isRaw);
    this.input.setRawMode(true);
    this.input.resume();
    try {
      for await (const source of this.iterator) {
        const chunk = Buffer.from(source);
        try {
          for (const byte of chunk) {
            if (byte === 0x03) throw new DOMException('setup interrupted', 'AbortError');
            if (byte === 0x0a || byte === 0x0d) {
              this.output.write('\n');
              return Buffer.from(value.subarray(0, length));
            }
            if (byte === 0x7f || byte === 0x08) {
              if (length > 0) length -= 1;
              continue;
            }
            if (length >= maxBytes) throw new Error('secret exceeded the safety bound');
            value[length] = byte;
            length += 1;
          }
        } finally {
          chunk.fill(0);
        }
      }
      throw new Error('stdin ended before the secret');
    } finally {
      value.fill(0);
      this.input.setRawMode(wasRaw);
      this.input.pause();
    }
  }

  clear() {
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
  }
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
  let githubToken;
  let openRouterSecret;
  try {
    const answer = consent.toString('utf8').trim().toLowerCase();
    if (answer !== 'yes') throw new Error('GitHub CLI token use requires explicit consent');
    githubToken = await github.readToken();
    if (
      !Buffer.isBuffer(githubToken) ||
      githubToken.length === 0 ||
      githubToken.length > MAX_SECRET_BYTES
    ) {
      throw new Error('GitHub CLI token is outside the safety bound');
    }

    const service = openRouterService(target.id);
    const account = openRouterAccount();
    const existing = await credentialStore.get(service, account);
    if (existing === null) {
      const entered = await prompt.line('OpenRouter API key: ', { secret: true });
      openRouterSecret = trimmedSecret(entered, 'OpenRouter key');
      entered.fill(0);
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
    githubToken?.fill(0);
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
  const githubToken = await github.readToken();
  let openrouter;
  try {
    const stored = await credentialStore.get(setup.openrouter.service, setup.openrouter.account);
    if (stored === null)
      throw new Error('The target/profile OpenRouter key is missing from the OS keyring');
    openrouter = Buffer.from(stored, 'utf8');
    if (openrouter.length === 0 || openrouter.length > MAX_SECRET_BYTES) {
      throw new Error('The target/profile OpenRouter key is outside the safety bound');
    }
    return { githubToken, openrouterKey: openrouter };
  } catch (error) {
    githubToken.fill(0);
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
