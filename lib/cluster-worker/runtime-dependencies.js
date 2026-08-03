'use strict';

const { randomUUID } = require('crypto');
const { createDeploymentProfileRegistry } = require('./profiles');

const DEPENDENCY_KEYS = new Set([
  'profileRegistry',
  'artifactResolver',
  'artifactReceiptSink',
  'engineAdapter',
  'clock',
  'timers',
  'idFactory',
  'cleanupFailureReporter',
]);

function assertRuntimeDependencies(dependencies) {
  const unknownDependencies = Object.keys(dependencies).filter((key) => !DEPENDENCY_KEYS.has(key));
  if (unknownDependencies.length > 0) {
    throw new Error(`Unsupported worker dependencies: ${unknownDependencies.join(', ')}`);
  }
  if (
    dependencies.cleanupFailureReporter !== undefined &&
    typeof dependencies.cleanupFailureReporter !== 'function'
  ) {
    throw new Error('cleanupFailureReporter must be a function');
  }
}

function applyRuntimeDependencyDefaults(dependencies, defaultCleanupFailureReporter) {
  return {
    profileRegistry: dependencies.profileRegistry || createDeploymentProfileRegistry(),
    artifactResolver: dependencies.artifactResolver || null,
    artifactReceiptSink: dependencies.artifactReceiptSink || null,
    engineAdapter:
      dependencies.engineAdapter || require('./engine-adapter').createCurrentEngineAdapter(),
    clock: dependencies.clock || (() => Date.now()),
    timers: dependencies.timers || { setTimeout, clearTimeout },
    idFactory: dependencies.idFactory || (() => `legacy-worker-${randomUUID()}`),
    cleanupFailureReporter: dependencies.cleanupFailureReporter || defaultCleanupFailureReporter,
  };
}

function resolveRuntimeDependencies(dependencies, defaultCleanupFailureReporter) {
  assertRuntimeDependencies(dependencies);
  return applyRuntimeDependencyDefaults(dependencies, defaultCleanupFailureReporter);
}

module.exports = { resolveRuntimeDependencies };
