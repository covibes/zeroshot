'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  checkHostedSetup,
  configureTargetSetup,
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

it('stores only the fixed nonsecret hosted selection', async () => {
  const state = {
    _targets: {
      prod: { id: 'target-1', url: 'https://target.example', createdAt: '2026-08-03T00:00:00Z' },
    },
  };
  let secretReads = 0;
  const metadata = await configureTargetSetup({
    targetName: 'prod',
    target: state._targets.prod,
    repository: 'owner/repository',
    provider: 'codex',
    modelLevel: 'level2',
    settings: {
      mutate: (mutator) => mutator(state),
    },
    credentialStore: {
      get() {
        secretReads += 1;
        throw new Error('setup must not read a keyring');
      },
    },
    github: {
      inspect() {
        secretReads += 1;
        throw new Error('setup must not inspect GitHub credentials');
      },
      acquire() {
        secretReads += 1;
        throw new Error('setup must not acquire GitHub credentials');
      },
    },
    prompt: {
      line() {
        secretReads += 1;
        throw new Error('setup must not prompt');
      },
    },
    clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
  });
  assert.equal(secretReads, 0);
  assert.deepEqual(
    {
      kind: metadata.kind,
      repository: metadata.repository,
      provider: metadata.provider,
      modelLevel: metadata.modelLevel,
    },
    {
      kind: 'zeroshot.private-hosted-setup/v1',
      repository: 'owner/repository',
      provider: 'codex',
      modelLevel: 'level2',
    }
  );
  assert.deepEqual(checkHostedSetup(state._targets.prod), metadata);
  assert.equal(JSON.stringify(state).match(/token|apiKey|openrouter|keyring/gi), null);
});

it('rejects any repository, provider, or model-level mismatch without mutation', async () => {
  for (const options of [
    { repository: 'owner/repo.git', provider: 'codex', modelLevel: 'level2' },
    { repository: 'Owner/Repo', provider: 'codex', modelLevel: 'level2' },
    { repository: 'owner/repo', provider: 'gateway', modelLevel: 'level2' },
    { repository: 'owner/repo', provider: 'codex', modelLevel: 'level3' },
  ]) {
    const state = { _targets: { prod: { id: 'target-1' } } };
    await assert.rejects(
      configureTargetSetup({
        targetName: 'prod',
        target: state._targets.prod,
        ...options,
        settings: { mutate: (mutator) => mutator(state) },
      })
    );
    assert.equal(state._targets.prod.hostedSetup, undefined);
  }
});
