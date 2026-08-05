'use strict';

const crypto = require('node:crypto');
const { checkHostedSetup } = require('./credentials');
const { HostedRunOrchestrator } = require('./orchestrator');
const {
  isDeterministicAllocationRefusal,
  RemoteAllocationUncertainError,
} = require('./orchestrator-support');
const { buildQueuedHostedExecution } = require('./queued-execution');
const { readHostedInputs } = require('./readers');
const {
  RunIntentClient,
  RunIntentHttpError,
  RunIntentRequestError,
  buildRunIntentEnvelope,
  displayRunIntentState,
  followRunIntent,
} = require('./run-intent');
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

function defaultRunIntentClient(context) {
  if (context.descriptor.runIntent === null) {
    throw new Error('target does not advertise RunIntent v2');
  }
  return new RunIntentClient({
    descriptor: context.descriptor.runIntent,
    organizationId: context.target.organization.id,
    tokenProvider: context.tokenProvider,
    clearAccess: () => context.sessionManager.clearMemory(),
    fetch: (url, init) => context.http.fetch(url, init),
  });
}

function isDeterministicSubmissionError(error) {
  return (
    error instanceof RunIntentRequestError ||
    (error instanceof RunIntentHttpError && error.status < 500)
  );
}

function submissionUncertain(submissionKey, cause) {
  return new Error(
    'RunIntent submission outcome is uncertain. Do not create a replacement. ' +
      `Recover by rerunning the same command with --submission-key ${submissionKey}.`,
    { cause }
  );
}

function resumeCommand(targetName, intentId) {
  return `zeroshot target status ${targetName} ${intentId} --follow`;
}

function printRunIntentState(intent) {
  console.log(`Run ${intent.intent_id}: ${displayRunIntentState(intent)}`);
}

function finishRunIntent(intent) {
  if (intent.state === 'succeeded') {
    if (intent.result === null) {
      console.log(`Run ${intent.intent_id} succeeded; its result is no longer retained.`);
      return intent;
    }
    console.log(JSON.stringify(intent.result, null, 2));
    return intent;
  }
  const code = intent.error_code === null ? '' : ` (${intent.error_code})`;
  throw new Error(`queued hosted run ${intent.state}${code}`);
}

async function withDisconnectSignal(operation) {
  const abort = new AbortController();
  const onSigint = () =>
    abort.abort(new globalThis.DOMException('remote observation interrupted', 'AbortError'));
  process.once('SIGINT', onSigint);
  try {
    return await operation(abort.signal);
  } finally {
    process.removeListener('SIGINT', onSigint);
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
    contextFor: (name) => createSessionContext(name, runtime, settings, createHttp()),
    coordinatorFor: (init) => coordinatorFor(init),
    runIntentClientFor: (context) => runIntentClientFor(context),
    followQueuedRun: (...args) => followQueuedRun(...args),
  };
}

function followOptions(service, signal) {
  return {
    signal,
    ...(service.dependencies.runIntentSleep === undefined
      ? {}
      : { sleep: service.dependencies.runIntentSleep }),
    onChange: printRunIntentState,
  };
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

async function capsuleTerminate(service, capsuleId, options) {
  const context = await service.contextFor(options.target);
  const capsule = await context.adapter.terminate(capsuleId);
  console.log(`Termination requested for capsule ${capsule.id}; host state: ${capsule.state}`);
}

async function remoteRun(service, options) {
  const inputs = await service.inputReader(
    options.graph,
    options.input,
    service.runtime.cluster.assertGraphSpec
  );
  const context = await service.contextFor(options.target);
  const manifest = service.candidateManifest();
  const abort = new AbortController();
  const onSigint = () =>
    abort.abort(new globalThis.DOMException('remote observation interrupted', 'AbortError'));
  process.once('SIGINT', onSigint);
  try {
    const orchestrator = new HostedRunOrchestrator({
      assertGraphSpec: service.runtime.cluster.assertGraphSpec,
      readInputs: () => inputs,
      checkHostedSetup,
      createCoordinator: service.coordinatorFor,
      runtimeImageDigest: manifest.runtimeImageDigest,
      randomUUID: service.randomUUID,
      output: service.dependencies.orchestratorOutput,
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
}

async function submitQueuedRun(service, options, prepared, signal) {
  const execution = buildQueuedHostedExecution(
    prepared.inputs,
    checkHostedSetup(prepared.context.target),
    service.candidateManifest()
  );
  const submissionKey = options.submissionKey ?? service.randomUUID();
  const client = service.runIntentClientFor(prepared.context);
  console.log(`Submission key: ${submissionKey}`);
  let created;
  try {
    created = await client.submit({
      envelope: buildRunIntentEnvelope(execution.graph, execution.input),
      submissionKey,
      size: 'standard',
      signal,
    });
  } catch (error) {
    if (isDeterministicSubmissionError(error)) throw error;
    throw submissionUncertain(submissionKey, error);
  }
  return { client, created };
}

async function remoteQueueRun(service, options) {
  const inputs = await service.inputReader(
    options.graph,
    options.input,
    service.runtime.cluster.assertGraphSpec
  );
  const context = await service.contextFor(options.target);
  return withDisconnectSignal(async (signal) => {
    const { client, created } = await submitQueuedRun(
      service,
      options,
      { context, inputs },
      signal
    );
    console.log(`Run ${created.intent_id} queued`);
    console.log(`Resume: ${resumeCommand(options.target, created.intent_id)}`);
    if (options.detach) return created;
    console.log('Ctrl+C disconnects without cancelling.');
    try {
      const terminal = await service.followQueuedRun(
        client,
        created,
        followOptions(service, signal)
      );
      return finishRunIntent(terminal);
    } catch (error) {
      if (!signal.aborted) throw error;
      console.log(`Disconnected; run ${created.intent_id} was not cancelled.`);
      return created;
    }
  });
}

async function runIntentStatus(service, targetName, intentId, options) {
  const context = await service.contextFor(targetName);
  const client = service.runIntentClientFor(context);
  if (!options.follow) {
    const intent = await client.get(intentId);
    if (options.json) console.log(JSON.stringify(intent, null, 2));
    else printRunIntentState(intent);
    return intent;
  }
  return withDisconnectSignal(async (signal) => {
    const initial = await client.get(intentId, { signal });
    console.log(`Following ${intentId}; Ctrl+C disconnects without cancelling.`);
    console.log(`Resume: ${resumeCommand(targetName, intentId)}`);
    try {
      const terminal = await service.followQueuedRun(
        client,
        initial,
        followOptions(service, signal)
      );
      return finishRunIntent(terminal);
    } catch (error) {
      if (!signal.aborted) throw error;
      console.log(`Disconnected; run ${intentId} was not cancelled.`);
      return initial;
    }
  });
}

async function runIntentCancel(service, targetName, intentId) {
  const context = await service.contextFor(targetName);
  const intent = await service.runIntentClientFor(context).cancel(intentId);
  printRunIntentState(intent);
  return intent;
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

function createDefaultServices(dependencies) {
  const service = createServiceContext(dependencies);
  const target = createTargetServices({
    runtime: service.runtime,
    settings: service.settings,
    httpTransport: service.createHttp,
    requireTarget,
  });
  return Object.freeze({
    ...target,
    capsuleCreate: (options) => capsuleCreate(service, options),
    capsuleTerminate: (capsuleId, options) => capsuleTerminate(service, capsuleId, options),
    remoteRun: (options) => remoteRun(service, options),
    remoteQueueRun: (options) => remoteQueueRun(service, options),
    runIntentStatus: (targetName, intentId, options) =>
      runIntentStatus(service, targetName, intentId, options),
    runIntentCancel: (targetName, intentId) => runIntentCancel(service, targetName, intentId),
    remoteList: (options) => remoteList(service, options),
    remoteStatus: (capsuleId, options) => remoteStatus(service, capsuleId, options),
    remoteStop: (capsuleId, options) => remoteStop(service, capsuleId, options),
  });
}

module.exports = {
  createDefaultServices,
  createSessionContext,
  loadRuntime,
  sanitizeRemoteOperation,
};
