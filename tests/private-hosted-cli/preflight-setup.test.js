'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  checkHostedSetup,
  configureTargetSetup,
  resolveSubmissionBase,
  resolveRuntimeBundle,
} = require('../../private/hosted-cli-candidate/credentials');
const { readHostedInputs } = require('../../private/hosted-cli-candidate/readers');
const {
  normalizeRuntimeConfig,
  readRuntimeConfig,
} = require('../../private/hosted-cli-candidate/runtime-config');
const BASE_REVISION = 'b'.repeat(40);
const GRAPH_FIXTURE = path.join(
  __dirname,
  '../../protocol/openengine-cluster/v1/fixtures/graph/positive/single-worker.json'
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
  const clusterConfigPath = path.join(root, 'cluster.json');
  const clusterBytes = '{"name":"custom","agents":[]}\n';
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
  fs.writeFileSync(clusterConfigPath, clusterBytes);
  const metadata = await configureTargetSetup({
    targetName: 'prod',
    target: state._targets.prod,
    repository: 'owner/repository',
    base: BASE_REVISION,
    targetBranch: 'main',
    runtimeConfigPath,
    settings: {
      mutate: (mutator) => mutator(state),
    },
    clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
  });
  assert.equal(metadata.kind, 'zeroshot.private-hosted-setup/v3');
  assert.equal(metadata.repository, 'owner/repository');
  assert.deepEqual(metadata.base, {
    kind: 'commit',
    revision: BASE_REVISION,
    targetBranch: 'main',
  });
  assert.equal(metadata.runtimeConfigPath, runtimeConfigPath);
  assert.deepEqual(checkHostedSetup(state._targets.prod), metadata);
  assert.equal('runtime' in metadata, false);
  assert.equal(JSON.stringify(state).includes('bedrock-runner'), false);
  assert.equal(JSON.stringify(state).includes(directSecret), false);
  assert.equal(JSON.stringify(state).includes('aws-local-secret'), false);

  const bundle = await resolveRuntimeBundle(state._targets.prod, {
    mode: 'pr',
    environment: {
      GH_TOKEN: 'github-test-token',
      LOCAL_AWS_ACCESS_KEY_ID: 'aws-local-secret',
    },
    fetch: (url) => {
      assert.equal(
        url,
        `https://api.github.com/repos/owner/repository/git/commits/${BASE_REVISION}`
      );
      return new globalThis.Response(JSON.stringify({ sha: BASE_REVISION }), { status: 200 });
    },
    clusterConfigPath,
  });
  assert.equal(bundle.githubToken, 'github-test-token');
  assert.equal(bundle.baseRevision, BASE_REVISION);
  assert.deepEqual(bundle.delivery, {
    version: 'zeroshot.delivery/v1',
    mode: 'pr',
    repository: 'owner/repository',
    targetBranch: 'main',
    baseRevision: BASE_REVISION,
  });
  assert.equal(bundle.runtime.provider, 'bedrock-runner');
  assert.equal(bundle.runtime.executable, 'claude');
  assert.equal(bundle.runtime.environment.AWS_ACCESS_KEY_ID, 'aws-local-secret');
  assert.equal(bundle.runtime.environment.AWS_REGION, 'eu-west-1');
  assert.equal(bundle.runtime.settings.providerSettings.custom.apiKey, directSecret);
  assert.equal(bundle.runtime.files['cluster.json'], clusterBytes);
});

it('rejects nondeclarative hosted cluster config before resolving the submission base', async () => {
  const root = temp();
  const runtimeConfigPath = path.join(root, 'runtime.json');
  const clusterConfigPath = path.join(root, 'cluster.json');
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({ provider: 'claude' }));
  fs.writeFileSync(
    clusterConfigPath,
    '{"name":"unsafe","agents":[{"id":"worker","role":"implementation","triggers":[{"topic":"ISSUE_OPENED","action":"execute_task","logic":{"engine":"javascript","script":"return true;"}}]}]}'
  );
  const target = {
    hostedSetup: {
      kind: 'zeroshot.private-hosted-setup/v3',
      repository: 'owner/repository',
      base: { kind: 'branch', branch: 'main' },
      runtimeConfigPath,
      configuredAt: '2026-08-03T00:00:00.000Z',
    },
  };
  let fetched = false;
  await assert.rejects(
    resolveRuntimeBundle(target, {
      mode: 'ship',
      environment: { GH_TOKEN: 'github-test-token' },
      clusterConfigPath,
      fetch: () => {
        fetched = true;
        throw new Error('unexpected GitHub lookup');
      },
    }),
    /Hosted cluster config.*script.*not allowed/
  );
  assert.equal(fetched, false);
});

it('resolves omitted and named bases to one immutable submission revision', async () => {
  const requests = [];
  const fetch = (url) => {
    requests.push(url);
    const body = url.endsWith('/repos/owner/repository')
      ? { default_branch: 'trunk' }
      : { object: { sha: BASE_REVISION } };
    return new globalThis.Response(JSON.stringify(body), { status: 200 });
  };
  assert.deepEqual(
    await resolveSubmissionBase(
      { repository: 'owner/repository', base: { kind: 'default' } },
      'token',
      fetch
    ),
    { targetBranch: 'trunk', baseRevision: BASE_REVISION }
  );
  assert.deepEqual(
    await resolveSubmissionBase(
      { repository: 'owner/repository', base: { kind: 'branch', branch: 'release/next' } },
      'token',
      fetch
    ),
    { targetBranch: 'release/next', baseRevision: BASE_REVISION }
  );
  assert.match(requests.at(-1), /release%2Fnext$/);
});

it('validates generic runtime bounds and anchors mapped files to the config', () => {
  const runtime = (overrides) =>
    normalizeRuntimeConfig({ provider: 'custom', executable: 'claude', ...overrides });
  assert.equal(
    normalizeRuntimeConfig({ provider: 'azure-openai', executable: 'gateway' }).executable,
    'gateway'
  );
  assert.throws(
    () => normalizeRuntimeConfig({ provider: 'future-provider', executable: 'future-cli' }),
    /Unknown provider/
  );
  const reservedNames =
    'GH_TOKEN GITHUB_TOKEN GIT_ASKPASS GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_TERMINAL_PROMPT HOME LANG NODE_ENV PATH TMPDIR ZEROSHOT_HOSTED_BASE_REVISION ZEROSHOT_HOSTED_DELIVERY_MODE ZEROSHOT_HOSTED_DELIVERY_TARGET ZEROSHOT_HOSTED_DELIVERY_VERSION ZEROSHOT_HOSTED_EXECUTABLE ZEROSHOT_HOSTED_EXEC_ROOT ZEROSHOT_HOSTED_MODEL ZEROSHOT_HOSTED_PROVIDER ZEROSHOT_HOSTED_REPOSITORY ZEROSHOT_ISOLATION_PROFILE ZEROSHOT_PROVIDER_PROFILE ZEROSHOT_SETTINGS_FILE'.split(
      ' '
    );
  for (const name of reservedNames) {
    assert.throws(() => runtime({ environment: { [name]: '/escape' } }), /reserved/);
  }
  for (const filename of ['../escape', 'settings.json', 'settings.json/nested']) {
    assert.throws(() => runtime({ files: { [filename]: 'secret' } }), /runtime file path/);
  }

  const root = temp();
  const configFile = path.join(root, 'config/runtime.json');
  fs.mkdirSync(path.dirname(configFile));
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
      base: 'main',
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'Owner/Repo',
      base: 'main',
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'owner/repo',
      base: 'branch..invalid',
      runtimeConfigPath: validRuntimeConfig,
    },
    {
      repository: 'owner/repo',
      base: BASE_REVISION,
      targetBranch: 'main',
      runtimeConfigPath: emptyProviderConfig,
    },
    {
      repository: 'owner/repo',
      base: BASE_REVISION,
      targetBranch: 'main',
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
