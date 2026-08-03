'use strict';

const { CANCELLED, createArtifactPreparation } = require('./runtime-support');

function createEngineStart(runtime, request, clusterId) {
  const prepareArtifacts =
    request.source === 'artifact'
      ? createArtifactPreparation({
          resolver: runtime.artifactResolver,
          artifacts: request.artifacts,
          clusterId,
          getProfile: () => runtime.profile,
          signal: runtime.preparationController.signal,
          reportFailure: runtime.cleanupFailureReporter,
        })
      : null;
  return Promise.resolve(
    runtime.engineAdapter.start({
      request,
      profile: runtime.profile,
      ...(prepareArtifacts ? { prepareArtifacts } : {}),
      clusterId,
      onEvent: runtime.onEngineEvent,
    })
  );
}

function assertEngineResource(resource, request, clusterId) {
  if (resource?.clusterId && resource.clusterId !== clusterId) {
    throw new Error('Engine allocated a cluster with a different id');
  }
  if (request.source === 'artifact' && resource?.artifactsStaged !== true) {
    throw new Error('Engine started without staging artifact input');
  }
}

async function acceptEngineStart(runtime, resource, request, clusterId) {
  if (resource === CANCELLED) {
    if (!runtime.machine.terminalReceipt) await runtime.machine.result();
    return runtime.machine.status();
  }
  assertEngineResource(resource, request, clusterId);
  if (runtime.machine.state === 'starting') runtime.machine.transition('running');
  return runtime.machine.status();
}

async function handleEngineStartFailure(runtime, error) {
  if (runtime.claimTerminalAuthority('engine:start')) {
    runtime.machine.terminal(runtime.failureReceipt('failed', 'crash', 'declared_failure'));
  }
  await runtime.stopEngine();
  if (runtime.terminalAuthority !== 'engine:start' && !runtime.machine.terminalReceipt) {
    await runtime.machine.result();
    return runtime.machine.status();
  }
  throw error;
}

module.exports = { acceptEngineStart, createEngineStart, handleEngineStartFailure };
