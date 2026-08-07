'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  checkHostedSetup,
  configureTargetSetup,
  resolveRuntimeBundle,
} = require('../../private/hosted-cli-candidate/credentials');
const {
  normalizeRuntimeConfig,
  readRuntimeConfig,
} = require('../../private/hosted-cli-candidate/runtime-config');
const { readHostedInputs } = require('../../private/hosted-cli-candidate/readers');
const BASE_REVISION = 'b'.repeat(40);
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

it('stores references and resolves one provider-neutral runtime bundle per run', async () => {
  const root = temp();
  const runtimeConfigPath = path.join(root, 'runtime.json');
  const directSecret = 'direct-provider-secret';
  const state = {
    _targets: {
      prod: { id: 'target-1', url: 'https://target.example', createdAt: '2026-08-03T00:00:00Z' },
    },
  };
  const runtime = {
    provider: 'bedrock-runner',
    executable: 'claude',
    model: 'anthropic.claude-sonnet-4-5',
    environment: {
      AWS_ACCESS_KEY_ID: { from: 'LOCAL_AWS_ACCESS_KEY_ID' },
      AWS_REGION: 'eu-west-1',
    },
    files: { '.config/provider.json': '{"endpoint":"https://models.example"}' },
    settings: { providerSettings: { custom: { apiKey: directSecret } } },
  };
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(runtime));
  const metadata = await configureTargetSetup({
    targetName: 'prod',
    target: state._targets.prod,
    repository: 'owner/repository',
    baseRevision: BASE_REVISION,
    runtimeConfigPath,
    settings: {
      mutate: (mutator) => mutator(state),
    },
    clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
  });
  assert.equal(metadata.kind, 'zeroshot.private-hosted-setup/v2');
  assert.equal(metadata.repository, 'owner/repository');
  assert.equal(metadata.baseRevision, BASE_REVISION);
  assert.equal(metadata.runtimeConfigPath, runtimeConfigPath);
  assert.deepEqual(checkHostedSetup(state._targets.prod), metadata);
  assert.equal('runtime' in metadata, false);
  assert.equal(JSON.stringify(state).includes('bedrock-runner'), false);
  assert.equal(JSON.stringify(state).includes(directSecret), false);
  assert.equal(JSON.stringify(state).includes('aws-local-secret'), false);

  const bundle = resolveRuntimeBundle(state._targets.prod, {
    GH_TOKEN: 'github-test-token',
    LOCAL_AWS_ACCESS_KEY_ID: 'aws-local-secret',
  });
  assert.equal(bundle.githubToken, 'github-test-token');
  assert.equal(bundle.baseRevision, BASE_REVISION);
  assert.equal(bundle.runtime.provider, 'bedrock-runner');
  assert.equal(bundle.runtime.executable, 'claude');
  assert.equal(bundle.runtime.environment.AWS_ACCESS_KEY_ID, 'aws-local-secret');
  assert.equal(bundle.runtime.environment.AWS_REGION, 'eu-west-1');
  assert.equal(bundle.runtime.settings.providerSettings.custom.apiKey, directSecret);
});

it('validates generic runtime bounds and anchors mapped files to the config', () => {
  assert.deepEqual(
    normalizeRuntimeConfig({
      provider: 'azure-openai',
      executable: 'gateway',
      environment: {},
      files: {},
      settings: {},
    }).executable,
    'gateway'
  );
  assert.equal(
    normalizeRuntimeConfig({ provider: 'future-provider', executable: 'future-cli' }).executable,
    'future-cli'
  );
  for (const name of [
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
    'ZEROSHOT_HOSTED_EXECUTABLE',
    'ZEROSHOT_HOSTED_EXEC_ROOT',
    'ZEROSHOT_HOSTED_MODEL',
    'ZEROSHOT_HOSTED_PROVIDER',
    'ZEROSHOT_HOSTED_REPOSITORY',
    'ZEROSHOT_ISOLATION_PROFILE',
    'ZEROSHOT_PROVIDER_PROFILE',
    'ZEROSHOT_SETTINGS_FILE',
  ]) {
    assert.throws(
      () =>
        normalizeRuntimeConfig({
          provider: 'custom',
          executable: 'claude',
          environment: { [name]: '/escape' },
        }),
      /reserved/
    );
  }
  for (const filename of ['../escape', 'settings.json', 'settings.json/nested']) {
    assert.throws(
      () =>
        normalizeRuntimeConfig({
          provider: 'custom',
          executable: 'claude',
          files: { [filename]: 'secret' },
        }),
      /runtime file path/
    );
  }

  const root = temp();
  const configDirectory = path.join(root, 'config');
  const configFile = path.join(configDirectory, 'runtime.json');
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      provider: 'custom',
      executable: 'claude',
      files: { '.config/harness.json': { from: '../credentials/harness.json' } },
    })
  );
  assert.equal(
    readRuntimeConfig(configFile).files['.config/harness.json'].from,
    path.join(root, 'credentials', 'harness.json')
  );
});

it('rejects invalid repository or runtime configuration without mutation', () => {
  const root = temp();
  const validRuntimeConfig = path.join(root, 'valid.json');
  const emptyProviderConfig = path.join(root, 'empty-provider.json');
  const unknownFieldConfig = path.join(root, 'unknown-field.json');
  fs.writeFileSync(validRuntimeConfig, JSON.stringify({ provider: 'claude' }));
  fs.writeFileSync(emptyProviderConfig, JSON.stringify({ provider: '' }));
  fs.writeFileSync(unknownFieldConfig, JSON.stringify({ provider: 'claude', unknown: true }));
  for (const options of [
    {
      repository: 'owner/repo.git',
      baseRevision: BASE_REVISION,
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'Owner/Repo',
      baseRevision: BASE_REVISION,
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'owner/repo',
      baseRevision: 'not-a-commit',
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'owner/repo',
      baseRevision: BASE_REVISION,
      runtimeConfigPath: emptyProviderConfig,
    },
    {
      repository: 'owner/repo',
      baseRevision: BASE_REVISION,
      runtimeConfigPath: unknownFieldConfig,
    },
  ]) {
    const state = { _targets: { prod: { id: 'target-1' } } };
    assert.throws(() =>
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
