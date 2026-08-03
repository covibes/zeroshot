'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  configureTargetSetup,
  openRouterAccount,
  openRouterService,
  PromptInput,
} = require('../../private/hosted-cli-candidate/credentials');
const { readHostedInputs } = require('../../private/hosted-cli-candidate/readers');
const GRAPH_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'protocol',
  'openengine-cluster',
  'v1',
  'fixtures',
  'graph',
  'positive',
  'single-worker.json'
);

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'zeroshot-candidate-'));
  roots.push(root);
  return root;
}

describe('explicit hosted readers', () => {
  it('accepts explicit JSON null input and the exact single-worker graph', async () => {
    const root = temp();
    const graphPath = path.join(root, 'graph.json');
    const inputPath = path.join(root, 'input.json');
    fs.copyFileSync(GRAPH_FIXTURE, graphPath);
    fs.writeFileSync(inputPath, 'null');
    const result = await readHostedInputs(graphPath, inputPath, (value) =>
      assert.equal(value.profile, 'openengine.graph.single-worker/v1')
    );
    assert.equal(result.input, null);
  });

  it('rejects symlinks and wrong profiles before any caller side effect', async () => {
    const root = temp();
    const real = path.join(root, 'real.json');
    const link = path.join(root, 'link.json');
    const inputPath = path.join(root, 'input.json');
    fs.copyFileSync(GRAPH_FIXTURE, real);
    fs.symlinkSync(real, link);
    fs.writeFileSync(inputPath, 'null');
    await assert.rejects(
      readHostedInputs(link, inputPath, () => undefined),
      /symbolic link/
    );

    const wrong = JSON.parse(fs.readFileSync(GRAPH_FIXTURE, 'utf8'));
    wrong.profile = 'openengine.graph.full/v1';
    fs.writeFileSync(real, JSON.stringify(wrong));
    await assert.rejects(
      readHostedInputs(real, inputPath, () => undefined),
      /single-worker/
    );
  });
});

it('requires explicit consent, stores only OpenRouter in target/profile keyring, and zeroes buffers', async () => {
  const githubCanary = Buffer.from('github-canary-884');
  const openrouterCanary = Buffer.from('openrouter-canary-884');
  const consent = Buffer.from('yes');
  const state = {
    _targets: {
      prod: { id: 'target-1', url: 'https://target.example', createdAt: '2026-08-03T00:00:00Z' },
    },
  };
  const keyring = new Map();
  const credentialStore = {
    async get(service, account) {
      return keyring.get(`${service}:${account}`) ?? null;
    },
    async set(service, account, value) {
      keyring.set(`${service}:${account}`, value);
    },
    async delete(service, account) {
      keyring.delete(`${service}:${account}`);
    },
  };
  let promptCount = 0;
  const prompt = {
    async line(_text, options) {
      promptCount += 1;
      return options?.secret ? openrouterCanary : consent;
    },
    clear() {},
  };
  const metadata = await configureTargetSetup({
    targetName: 'prod',
    target: state._targets.prod,
    repository: 'owner/repository',
    provider: 'codex-openrouter',
    settings: {
      load: () => state,
      mutate: (mutator) => mutator(state),
    },
    credentialStore,
    github: {
      async inspect() {
        return { source: 'gh-cli', host: 'github.com', account: 'octocat' };
      },
      async readToken() {
        return githubCanary;
      },
    },
    prompt,
    clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
  });
  assert.equal(promptCount, 2);
  assert.equal(
    keyring.get(`${openRouterService('target-1')}:${openRouterAccount()}`),
    'openrouter-canary-884'
  );
  assert.ok(githubCanary.every((byte) => byte === 0));
  assert.ok(openrouterCanary.every((byte) => byte === 0));
  assert.ok(consent.every((byte) => byte === 0));
  const settingsJson = JSON.stringify(state);
  assert.equal(settingsJson.includes('github-canary-884'), false);
  assert.equal(settingsJson.includes('openrouter-canary-884'), false);
  assert.equal(JSON.stringify(metadata).includes('canary'), false);
  assert.equal(metadata.repository, 'github.com/owner/repository');
  assert.equal(metadata.github.account, 'octocat');
});

it('does not read either secret when GitHub CLI use is declined', async () => {
  const state = { _targets: { prod: { id: 'target-1' } } };
  let tokenReads = 0;
  let keyringReads = 0;
  const no = Buffer.from('no');
  await assert.rejects(
    configureTargetSetup({
      targetName: 'prod',
      target: state._targets.prod,
      repository: 'owner/repo',
      provider: 'codex-openrouter',
      settings: { load: () => state, mutate: (mutator) => mutator(state) },
      credentialStore: {
        async get() {
          keyringReads += 1;
          return null;
        },
        async set() {},
        async delete() {},
      },
      github: {
        async inspect() {
          return { source: 'gh-cli', host: 'github.com', account: 'octocat' };
        },
        async readToken() {
          tokenReads += 1;
          return Buffer.from('forbidden');
        },
      },
      prompt: {
        async line() {
          return no;
        },
        clear() {},
      },
    }),
    /explicit consent/
  );
  assert.equal(tokenReads, 0);
  assert.equal(keyringReads, 0);
  assert.ok(no.every((byte) => byte === 0));
});

it('supports explicit noninteractive consent and secret on bounded stdin lines', async () => {
  const { Readable } = require('node:stream');
  const input = Readable.from([Buffer.from('yes\nopenrouter-from-stdin\n')]);
  const output = { write() {} };
  const prompt = new PromptInput(input, output);
  const consent = await prompt.line('consent: ', { maxBytes: 8 });
  const secret = await prompt.line('secret: ', { secret: true });
  assert.equal(consent.toString('utf8'), 'yes');
  assert.equal(secret.toString('utf8'), 'openrouter-from-stdin');
  consent.fill(0);
  secret.fill(0);
  prompt.clear();
});
