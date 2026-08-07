'use strict';

const crypto = require('node:crypto');
const { createCapsuleServices, sanitizeRemoteOperation } = require('./default-capsule-services');
const {
  createRunIntentServices,
  defaultRunIntentClient,
} = require('./default-run-intent-services');
const { readHostedInputs } = require('./readers');
const { resolveRuntimeBundle } = require('./credentials');
const { followRunIntent } = require('./run-intent');
const { createTargetServices, targetSessionManager } = require('./target-services');

function loadRuntime() {
  return Object.freeze({
    target: require('../target'),
    hostedTarget: require('../hosted-target/index.cjs'),
    hostedSession: require('../hosted-session/index.cjs'),
    cluster: require('../cluster/index.cjs'),
  });
}

function httpTransport() {
  return { fetch: (url, init) => globalThis.fetch(url, init) };
}

function targetSettings(dependencies) {
  return {
    load: () => dependencies.loadSettings(),
    mutate: (mutator) => dependencies.mutateSettings(mutator),
  };
}

function requireTarget(name, runtime, settings) {
  const target = runtime.target.getTarget(name, settings);
  if (!target) throw new Error(`Target "${name}" not found.`);
  return target;
}

function requireOrganization(target) {
  if (!target.organization?.id) {
    throw new Error('Target login is required before remote capsule operations');
  }
}

async function createSessionContext(name, runtime, settings, http = httpTransport()) {
  const target = requireTarget(name, runtime, settings);
  requireOrganization(target);
  const endpoints = await runtime.target.discoverTargetSessionEndpoints(target.url, http);
  const descriptor = endpoints.descriptor;
  const credentialStore = await runtime.target.KeyringCredentialStore.create();
  const sessionManager = targetSessionManager({
    runtime,
    settings,
    name,
    target,
    endpoints,
    credentialStore,
    open: () => Promise.resolve(),
    http,
  });
  const tokenProvider = sessionManager.tokenProvider('capsule');
  const adapter = runtime.hostedTarget.createTargetAdapter({
    descriptor,
    organization: { id: target.organization.id },
    tokenProvider,
  });
  return {
    target,
    descriptor,
    credentialStore,
    sessionManager,
    tokenProvider,
    adapter,
    http,
  };
}

function buildManifest() {
  try {
    const manifest = require('./candidate-build.json');
    if (manifest.privateMarker !== 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH') {
      throw new Error('private candidate marker is missing');
    }
    return manifest;
  } catch (error) {
    throw new Error('private candidate build manifest is unavailable', { cause: error });
  }
}

function createServiceContext(dependencies) {
  const runtime = dependencies.runtime ?? loadRuntime();
  const settings = targetSettings(dependencies);
  const createHttp = dependencies.httpTransport ?? httpTransport;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const inputReader = dependencies.readHostedInputs ?? readHostedInputs;
  const coordinatorFor =
    dependencies.createCoordinator ??
    ((init) => new runtime.hostedSession.HostedSessionCoordinator(init));
  const runIntentClientFor = dependencies.createRunIntentClient ?? defaultRunIntentClient;
  const followQueuedRun = dependencies.followRunIntent ?? followRunIntent;
  return {
    dependencies,
    runtime,
    settings,
    createHttp,
    randomUUID: () => randomUUID(),
    inputReader: (...args) => inputReader(...args),
    candidateManifest: () => dependencies.manifest ?? buildManifest(),
    runtimeBundleFor: (target) =>
      resolveRuntimeBundle(target, dependencies.environment ?? process.env),
    contextFor: (name) => createSessionContext(name, runtime, settings, createHttp()),
    coordinatorFor: (init) => coordinatorFor(init),
    runIntentClientFor: (context) => runIntentClientFor(context),
    followQueuedRun: (...args) => followQueuedRun(...args),
  };
}

function createDefaultServices(dependencies) {
  const service = createServiceContext(dependencies);
  return Object.freeze({
    ...createTargetServices({
      runtime: service.runtime,
      settings: service.settings,
      httpTransport: service.createHttp,
      requireTarget,
    }),
    ...createCapsuleServices(service),
    ...createRunIntentServices(service),
  });
}

module.exports = {
  createDefaultServices,
  createSessionContext,
  loadRuntime,
  sanitizeRemoteOperation,
};
