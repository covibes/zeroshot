'use strict';

const crypto = require('node:crypto');
const { checkHostedSetup } = require('./credentials');
const { HostedRunOrchestrator } = require('./orchestrator');
const {
  isDeterministicAllocationRefusal,
  RemoteAllocationUncertainError,
} = require('./orchestrator-support');
const { readHostedInputs } = require('./readers');
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
  if (!target.organization?.id)
    throw new Error('Target login is required before remote capsule operations');
}

async function createSessionContext(name, runtime, settings, http = httpTransport()) {
  const target = requireTarget(name, runtime, settings);
  requireOrganization(target);
  const descriptor = await runtime.target.discoverTarget(target.url, http);
  const credentialStore = await runtime.target.KeyringCredentialStore.create();
  const sessionManager = targetSessionManager({
    runtime,
    settings,
    name,
    target,
    descriptor,
    credentialStore,
    open: () => Promise.resolve(),
    http,
  });
  const adapter = runtime.hostedTarget.createTargetAdapter({
    descriptor,
    organization: { id: target.organization.id },
    tokenProvider: sessionManager.tokenProvider('capsule'),
  });
  return { target, descriptor, credentialStore, sessionManager, adapter };
}

function outputCapsule(capsule, json) {
  if (json) {
    console.log(JSON.stringify(capsule, null, 2));
  } else {
    console.log(`${capsule.id}\t${capsule.state}\t${capsule.label ?? ''}\t${capsule.createdAt}`);
  }
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

async function sanitizeRemoteOperation(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`Remote ${label} failed; peer-controlled detail was suppressed.`);
  }
}

function createDefaultServices(dependencies) {
  const runtime = dependencies.runtime ?? loadRuntime();
  const settings = targetSettings(dependencies);
  const createHttp = dependencies.httpTransport ?? httpTransport;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const inputReader = dependencies.readHostedInputs ?? readHostedInputs;
  const candidateManifest = () => dependencies.manifest ?? buildManifest();
  const contextFor = (name) => createSessionContext(name, runtime, settings, createHttp());
  const coordinatorFor =
    dependencies.createCoordinator ??
    ((init) => new runtime.hostedSession.HostedSessionCoordinator(init));
  const services = {
    ...createTargetServices({ runtime, settings, httpTransport: createHttp, requireTarget }),

    async capsuleCreate(options) {
      const context = await contextFor(options.target);
      if (options.size !== undefined && !context.descriptor.sizes.catalog.includes(options.size)) {
        throw new Error('capsule size is not advertised by the target');
      }
      const allocationIdempotencyKey = `capsule_${randomUUID().replaceAll('-', '')}`;
      console.log(`Allocation key: ${allocationIdempotencyKey}`);
      let capsule;
      try {
        capsule = await context.adapter.allocate({
          idempotencyKey: allocationIdempotencyKey,
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(options.size === undefined ? {} : { size: options.size }),
        });
      } catch (error) {
        if (isDeterministicAllocationRefusal(error)) throw error;
        throw new RemoteAllocationUncertainError(allocationIdempotencyKey, error);
      }
      console.log(`Capsule: ${capsule.id}`);
      outputCapsule(capsule, false);
    },

    async capsuleTerminate(capsuleId, options) {
      const context = await contextFor(options.target);
      const capsule = await context.adapter.terminate(capsuleId);
      console.log(`Termination requested for capsule ${capsule.id}; host state: ${capsule.state}`);
    },

    async remoteRun(options) {
      const inputs = await inputReader(
        options.graph,
        options.input,
        runtime.cluster.assertGraphSpec
      );
      const context = await contextFor(options.target);
      const manifest = candidateManifest();
      const abort = new AbortController();
      const onSigint = () =>
        abort.abort(new globalThis.DOMException('remote observation interrupted', 'AbortError'));
      process.once('SIGINT', onSigint);
      try {
        const orchestrator = new HostedRunOrchestrator({
          assertGraphSpec: runtime.cluster.assertGraphSpec,
          readInputs: () => inputs,
          checkHostedSetup,
          createCoordinator: coordinatorFor,
          runtimeImageDigest: manifest.runtimeImageDigest,
          randomUUID,
          output: dependencies.orchestratorOutput,
        });
        return await orchestrator.run({
          ...context,
          graphPath: options.graph,
          inputPath: options.input,
          detach: Boolean(options.detach),
          signal: abort.signal,
          expectedRepository: manifest.repository,
          expectedProvider: manifest.provider,
          expectedModelLevel: manifest.modelLevel,
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    },

    async remoteList(options) {
      const context = await contextFor(options.target);
      const page = await context.adapter.list(
        options.limit === undefined ? {} : { limit: options.limit }
      );
      if (options.json) {
        console.log(JSON.stringify(page, null, 2));
      } else {
        for (const capsule of page.capsules) outputCapsule(capsule, false);
        if (page.nextCursor !== null) console.log(`Next cursor: ${page.nextCursor}`);
      }
    },

    remoteStatus(capsuleId, options) {
      return sanitizeRemoteOperation('status', async () => {
        const context = await contextFor(options.target);
        const host = await context.adapter.inspect(capsuleId);
        let oecp = null;
        if (host.state === 'ready') {
          const coordinator = coordinatorFor({
            adapter: context.adapter,
            capsuleId,
            targetAuthority: context.target.url,
          });
          try {
            const session = await coordinator.open();
            oecp = await session.client.get({});
          } finally {
            await coordinator.close();
          }
        }
        const result = { host, oecp };
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`Host: ${host.state}`);
          console.log(`OECP: ${oecp === null ? 'unavailable' : oecp.status.phase}`);
        }
      });
    },

    remoteStop(capsuleId, options) {
      return sanitizeRemoteOperation('stop', async () => {
        const context = await contextFor(options.target);
        const host = await context.adapter.inspect(capsuleId);
        if (host.state !== 'ready') throw new Error('OECP stop is unavailable');
        const coordinator = coordinatorFor({
          adapter: context.adapter,
          capsuleId,
          targetAuthority: context.target.url,
        });
        try {
          const session = await coordinator.open();
          const current = await session.client.get({});
          const generation = current.status.observedGeneration;
          if (!Number.isSafeInteger(generation) || generation < 1) {
            throw new Error('capsule has no current OECP generation to stop');
          }
          const stopped = await session.client.stop({
            idempotencyKey: `stop_${randomUUID().replaceAll('-', '')}`,
            ifGeneration: generation,
            mode: options.force ? 'force' : 'drain',
          });
          console.log(
            `OECP ${stopped.effectiveMode} stop accepted for run ${stopped.runId}; ` +
              'host capsule was not terminated'
          );
        } finally {
          await coordinator.close();
        }
      });
    },
  };
  return Object.freeze(services);
}

module.exports = {
  createDefaultServices,
  createSessionContext,
  loadRuntime,
  sanitizeRemoteOperation,
};
