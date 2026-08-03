'use strict';

const { runClusterWorkerExecutable } = require('../../lib/cluster-worker/executable');
const { createLegacyClusterWorker } = require('../../lib/cluster-worker');
const { createFixedProxyEngineAdapter } = require('./engine-adapter');

const ISOLATION_PROFILE = 'isolation.prepared-worktree@1';
const PROVIDER_PROFILE = 'provider.fixed-proxy@1';
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

function fixedProfile() {
  return deepFreeze({
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    plan: { isolation: 'worktree', delivery: 'none', autoMerge: false },
    deployment: { prepared: true },
    provider: { fixedProxy: true },
    bounds: { ...BOUNDS },
  });
}

const profileRegistry = Object.freeze({
  bounds: BOUNDS,
  resolve(isolationProfile, providerProfile) {
    if (isolationProfile !== ISOLATION_PROFILE || providerProfile !== PROVIDER_PROFILE) {
      throw new Error('Legacy request does not use the fixed capsule profiles');
    }
    return fixedProfile();
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
  engineAdapter: createFixedProxyEngineAdapter(),
  cleanupFailureReporter() {
    process.stderr.write('hosted worker cleanup failed\n');
  },
});

runClusterWorkerExecutable({
  worker,
  frameBytes: BOUNDS.frameBytes,
  shutdownMs: BOUNDS.shutdownMs,
});
