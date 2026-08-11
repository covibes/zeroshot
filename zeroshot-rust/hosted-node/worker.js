'use strict';

// stdout is reserved for the legacy worker protocol. The old Node engine still
// contains informational console output that must not become protocol frames.
console.log = () => {};
console.info = () => {};
console.debug = () => {};

const { runClusterWorkerExecutable } = require('../../lib/cluster-worker/executable');
const { createLegacyClusterWorker } = require('../../lib/cluster-worker');
const { createHostedClusterEngineAdapter } = require('./engine-adapter');
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

function fixedProfile(config) {
  return deepFreeze({
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    plan: {
      isolation: 'worktree',
      delivery: 'none',
      autoMerge: false,
    },
    deployment: { prepared: true },
    provider: {
      ...config.cluster,
      validateConfig: config.cluster.config !== undefined,
      settings: config.settings,
      providerOverride: config.executable,
      forceProvider: config.executable,
      ...(config.model === undefined ? {} : { modelOverride: config.model }),
    },
    bounds: { ...BOUNDS },
  });
}

const hostedConfig = loadInstalledHostedWorkerConfiguration();
process.env.ZEROSHOT_TASK_EXECUTION_CONTEXT = 'docker';

const profileRegistry = Object.freeze({
  bounds: BOUNDS,
  resolve(isolationProfile, providerProfile) {
    if (isolationProfile !== ISOLATION_PROFILE || providerProfile !== PROVIDER_PROFILE) {
      throw new Error('Legacy request does not use the fixed capsule profiles');
    }
    return fixedProfile(hostedConfig);
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
  engineAdapter: createHostedClusterEngineAdapter(hostedConfig),
  cleanupFailureReporter() {
    process.stderr.write('hosted worker cleanup failed\n');
  },
});

runClusterWorkerExecutable({
  worker,
  frameBytes: BOUNDS.frameBytes,
  shutdownMs: BOUNDS.shutdownMs,
});
