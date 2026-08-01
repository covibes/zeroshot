'use strict';

const { resolveRunPlan } = require('../run-plan');
const { deepFreeze } = require('./object-utils');

const DEFAULT_BOUNDS = Object.freeze({
  executionMs: 60 * 60 * 1000,
  shutdownMs: 30 * 1000,
  frameBytes: 64 * 1024,
});

const DEFAULT_ISOLATION_PROFILES = Object.freeze({
  'isolation.worktree@1': Object.freeze({ worktree: true }),
  'isolation.docker@1': Object.freeze({ docker: true }),
  'isolation.pr@1': Object.freeze({ pr: true }),
  'isolation.ship@1': Object.freeze({ ship: true }),
});

const DEFAULT_PROVIDER_PROFILES = Object.freeze({
  'provider.default@1': Object.freeze({
    configName: 'conductor-bootstrap',
    providerOverride: null,
    settings: Object.freeze({}),
  }),
});

const HOSTED_CODEX_OPENROUTER_PROFILE = 'provider.codex-openrouter@1';
const DEFAULT_HOSTED_MODEL = 'openai/gpt-5.4';

function providerProfilesFromEnvironment(environment = process.env) {
  if (environment.ZEROSHOT_HOSTED_CODEX_OPENROUTER !== '1') {
    return DEFAULT_PROVIDER_PROFILES;
  }
  const model = environment.ZEROSHOT_HOSTED_MODEL || DEFAULT_HOSTED_MODEL;
  const levelOverrides = Object.freeze({
    level1: Object.freeze({ model, reasoningEffort: 'medium' }),
    level2: Object.freeze({ model, reasoningEffort: 'high' }),
    level3: Object.freeze({ model, reasoningEffort: 'xhigh' }),
  });
  return deepFreeze({
    ...DEFAULT_PROVIDER_PROFILES,
    [HOSTED_CODEX_OPENROUTER_PROFILE]: {
      configName: 'base-templates/single-worker',
      providerOverride: 'codex',
      forceProvider: 'codex',
      settings: {
        templateParams: { task_type: 'TASK' },
        providerSettings: {
          codex: {
            defaultLevel: 'level2',
            levelOverrides,
          },
        },
      },
    },
  });
}

function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function validateBounds(bounds) {
  for (const name of ['executionMs', 'shutdownMs', 'frameBytes']) {
    if (!Number.isSafeInteger(bounds[name]) || bounds[name] <= 0) {
      throw new Error(`Deployment bound ${name} must be a positive safe integer`);
    }
  }
}

function createDeploymentProfileRegistry(options = {}) {
  const isolationProfiles = options.isolationProfiles || DEFAULT_ISOLATION_PROFILES;
  const providerProfiles = options.providerProfiles || providerProfilesFromEnvironment();
  const defaultBounds = { ...DEFAULT_BOUNDS, ...(options.bounds || {}) };
  validateBounds(defaultBounds);
  const bounds = deepFreeze(defaultBounds);

  return Object.freeze({
    bounds,
    resolve(isolationHandle, providerHandle) {
      const deployment = own(isolationProfiles, isolationHandle);
      if (!deployment) throw new Error(`Unknown isolation profile: ${String(isolationHandle)}`);
      const provider = own(providerProfiles, providerHandle);
      if (!provider) throw new Error(`Unknown provider profile: ${String(providerHandle)}`);

      const plan = resolveRunPlan(deployment);
      if (plan.isolation !== 'worktree' && plan.isolation !== 'docker') {
        throw new Error(`Isolation profile ${isolationHandle} resolves to non-isolated execution`);
      }
      const resolvedBounds = {
        ...defaultBounds,
        ...(deployment.bounds || {}),
        ...(provider.bounds || {}),
      };
      validateBounds(resolvedBounds);
      return deepFreeze({
        isolationProfile: isolationHandle,
        providerProfile: providerHandle,
        plan,
        deployment: { ...deployment },
        provider: { ...provider },
        bounds: resolvedBounds,
      });
    },
  });
}

module.exports = {
  DEFAULT_BOUNDS,
  DEFAULT_ISOLATION_PROFILES,
  DEFAULT_PROVIDER_PROFILES,
  HOSTED_CODEX_OPENROUTER_PROFILE,
  createDeploymentProfileRegistry,
  providerProfilesFromEnvironment,
};
