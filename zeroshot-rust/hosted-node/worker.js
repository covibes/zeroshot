'use strict';

const { runClusterWorkerExecutable } = require('../../lib/cluster-worker/executable');
const { createLegacyClusterWorker } = require('../../lib/cluster-worker');
const { createHostedProviderEngineAdapter } = require('./engine-adapter');
const { loadInstalledHostedWorkerConfiguration } = require('./hosted-config');

const ISOLATION_PROFILE = 'isolation.prepared-worktree@1';
const PROVIDER_PROFILE = 'provider.hosted-direct@1';
const BOUNDS = Object.freeze({
  executionMs: 3_600_000,
  shutdownMs: 10_000,
  frameBytes: 64 * 1024,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fixedProfile(delivery) {
  return deepFreeze({
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    plan: {
      isolation: 'worktree',
      delivery: delivery.mode,
      autoMerge: delivery.mode === 'ship',
    },
    deployment: { prepared: true },
    provider: { hostedDirect: true },
    bounds: { ...BOUNDS },
  });
}

const hostedConfig = loadInstalledHostedWorkerConfiguration();

const profileRegistry = Object.freeze({
  bounds: BOUNDS,
  resolve(isolationProfile, providerProfile) {
    if (isolationProfile !== ISOLATION_PROFILE || providerProfile !== PROVIDER_PROFILE) {
      throw new Error('Legacy request does not use the fixed capsule profiles');
    }
    return fixedProfile(hostedConfig.delivery);
  },
});

const artifactResolver = Object.freeze({
  stage(artifacts) {
    return Object.freeze({ preparedArtifactCount: artifacts.length });
  },
});

const worker = createLegacyClusterWorker({
  profileRegistry,
  artifactResolver,
  engineAdapter: createHostedProviderEngineAdapter(hostedConfig),
  cleanupFailureReporter() {
    process.stderr.write('hosted worker cleanup failed\n');
  },
});

runClusterWorkerExecutable({
  worker,
  frameBytes: BOUNDS.frameBytes,
  shutdownMs: BOUNDS.shutdownMs,
});
