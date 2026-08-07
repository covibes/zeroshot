'use strict';
const { HostedRunOrchestrator } = require('./orchestrator');
const {
  isDeterministicAllocationRefusal,
  RemoteAllocationUncertainError,
} = require('./orchestrator-support');
const { withInterruptSignal } = require('./interrupt-signal');

function outputCapsule(capsule, json) {
  if (json) {
    console.log(JSON.stringify(capsule, null, 2));
  } else {
    console.log(`${capsule.id}\t${capsule.state}\t${capsule.label ?? ''}\t${capsule.createdAt}`);
  }
}

async function sanitizeRemoteOperation(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`Remote ${label} failed; peer-controlled detail was suppressed.`);
  }
}

async function capsuleCreate(service, options) {
  const context = await service.contextFor(options.target);
  if (options.size !== undefined && !context.descriptor.sizes.catalog.includes(options.size)) {
    throw new Error('capsule size is not advertised by the target');
  }
  const allocationIdempotencyKey = `capsule_${service.randomUUID().replaceAll('-', '')}`;
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
}

async function remoteRun(service, options) {
  const inputs = await service.inputReader(
    options.graph,
    options.input,
    service.runtime.cluster.assertGraphSpec
  );
  const context = await service.contextFor(options.target);
  const manifest = service.candidateManifest();
  return withInterruptSignal((signal) => {
    const orchestrator = new HostedRunOrchestrator({
      assertGraphSpec: service.runtime.cluster.assertGraphSpec,
      readInputs: () => inputs,
      resolveRuntimeBundle: service.runtimeBundleFor,
      createCoordinator: service.coordinatorFor,
      runtimeImageDigest: manifest.runtimeImageDigest,
      randomUUID: service.randomUUID,
      output: service.dependencies.orchestratorOutput,
    });
    return orchestrator.run({
      ...context,
      graphPath: options.graph,
      inputPath: options.input,
      detach: Boolean(options.detach),
      signal,
    });
  });
}

async function remoteList(service, options) {
  const context = await service.contextFor(options.target);
  const page = await context.adapter.list(
    options.limit === undefined ? {} : { limit: options.limit }
  );
  if (options.json) {
    console.log(JSON.stringify(page, null, 2));
  } else {
    for (const capsule of page.capsules) outputCapsule(capsule, false);
    if (page.nextCursor !== null) console.log(`Next cursor: ${page.nextCursor}`);
  }
}

function remoteStatus(service, capsuleId, options) {
  return sanitizeRemoteOperation('status', async () => {
    const context = await service.contextFor(options.target);
    const host = await context.adapter.inspect(capsuleId);
    let oecp = null;
    if (host.state === 'ready') {
      const coordinator = service.coordinatorFor({
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
}

function remoteStop(service, capsuleId, options) {
  return sanitizeRemoteOperation('stop', async () => {
    const context = await service.contextFor(options.target);
    const host = await context.adapter.inspect(capsuleId);
    if (host.state !== 'ready') throw new Error('OECP stop is unavailable');
    const coordinator = service.coordinatorFor({
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
        idempotencyKey: `stop_${service.randomUUID().replaceAll('-', '')}`,
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
}

function createCapsuleServices(service) {
  return {
    capsuleCreate: (options) => capsuleCreate(service, options),
    capsuleTerminate: async (capsuleId, options) => {
      const context = await service.contextFor(options.target);
      const capsule = await context.adapter.terminate(capsuleId);
      console.log(`Termination requested for capsule ${capsule.id}; host state: ${capsule.state}`);
    },
    remoteRun: (options) => remoteRun(service, options),
    remoteList: (options) => remoteList(service, options),
    remoteStatus: (capsuleId, options) => remoteStatus(service, capsuleId, options),
    remoteStop: (capsuleId, options) => remoteStop(service, capsuleId, options),
  };
}

module.exports = { createCapsuleServices, sanitizeRemoteOperation };
