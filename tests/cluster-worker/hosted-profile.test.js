'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, it } = require('mocha');
const {
  HOSTED_CODEX_OPENROUTER_PR_PROFILE,
  HOSTED_CODEX_OPENROUTER_PROFILE,
  createDeploymentProfileRegistry,
  providerProfilesFromEnvironment,
} = require('../../lib/cluster-worker/profiles');
const { prepareClusterConfig, resolveConfigPath } = require('../../lib/start-cluster');

describe('hosted Codex/OpenRouter deployment profile', function () {
  it('is absent unless the capsule host explicitly enables it', function () {
    const profiles = providerProfilesFromEnvironment({});
    assert.equal(profiles[HOSTED_CODEX_OPENROUTER_PROFILE], undefined);
    assert.equal(profiles[HOSTED_CODEX_OPENROUTER_PR_PROFILE], undefined);
  });

  it('uses the validated delivery template only for reviewed PR runs', function () {
    const providerProfiles = providerProfilesFromEnvironment({
      ZEROSHOT_HOSTED_CODEX_OPENROUTER: '1',
      ZEROSHOT_HOSTED_MODEL: 'openai/gpt-5.4',
    });
    const registry = createDeploymentProfileRegistry({ providerProfiles });
    const profile = registry.resolve('isolation.pr@1', HOSTED_CODEX_OPENROUTER_PR_PROFILE);

    assert.equal(profile.plan.delivery, 'pr');
    assert.equal(profile.provider.configName, 'base-templates/worker-validator');
    assert.equal(profile.provider.forceProvider, undefined);
    const config = prepareClusterConfig(
      JSON.parse(fs.readFileSync(resolveConfigPath(profile.provider.configName), 'utf8')),
      profile.provider.settings,
      profile.provider.providerOverride
    );
    assert.deepEqual(
      config.agents.map(({ id }) => id),
      ['worker', 'validator']
    );
    assert.equal(JSON.stringify(profile).includes('apiKey'), false);
  });

  it('pins the uploaded model across Zeroshot levels without carrying a key', function () {
    const providerProfiles = providerProfilesFromEnvironment({
      ZEROSHOT_HOSTED_CODEX_OPENROUTER: '1',
      ZEROSHOT_HOSTED_MODEL: 'openai/gpt-5.4',
    });
    const registry = createDeploymentProfileRegistry({ providerProfiles });
    const profile = registry.resolve('isolation.worktree@1', HOSTED_CODEX_OPENROUTER_PROFILE);

    assert.equal(profile.provider.providerOverride, 'codex');
    assert.equal(profile.provider.configName, 'base-templates/single-worker');
    assert.equal(profile.provider.forceProvider, undefined);
    const config = prepareClusterConfig(
      JSON.parse(fs.readFileSync(resolveConfigPath(profile.provider.configName), 'utf8')),
      profile.provider.settings,
      profile.provider.providerOverride
    );
    assert.match(config.agents[0].prompt.system, /TASK task/);
    assert.deepEqual(
      Object.values(profile.provider.settings.providerSettings.codex.levelOverrides).map(
        ({ model }) => model
      ),
      ['openai/gpt-5.4', 'openai/gpt-5.4', 'openai/gpt-5.4']
    );
    assert.equal(JSON.stringify(profile).includes('apiKey'), false);
  });
});
