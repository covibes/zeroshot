'use strict';

const { withInterruptSignal } = require('./interrupt-signal');
const { buildRunIntentExecution } = require('./run-intent-execution');
const {
  RunIntentClient,
  RunIntentHttpError,
  RunIntentRequestError,
  TERMINAL_STATES,
  buildRunIntentEnvelope,
  displayRunIntentState,
} = require('./run-intent');

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
      'Retry only if the title, graph, input, cluster config, runtime references, credentials, ' +
      'size, delivery mode, and resolved repository revision are unchanged. ' +
      `Then rerun with --submission-key ${submissionKey}; a changed payload is rejected.`,
    { cause }
  );
}

function resumeCommand(targetName, intentId) {
  return `zeroshot attach ${intentId} --target ${targetName}`;
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
  throw new Error(`hosted run ${intent.state}${code}`);
}

function observationOptions(service, signal, additional = {}) {
  return {
    signal,
    ...(service.dependencies.runIntentSleep === undefined
      ? {}
      : { sleep: service.dependencies.runIntentSleep }),
    onChange: printRunIntentState,
    ...additional,
  };
}

function safeWatchProjection(capsuleId, item) {
  if (item.type === 'closed') {
    return {
      capsuleId,
      observation: 'closed',
      reason: item.reason,
      ...(item.lastDeliveredCursor === undefined ? {} : { cursor: item.lastDeliveredCursor }),
    };
  }
  let phase;
  if (item.event.type === 'phase') phase = item.event.status.phase;
  if (item.event.type === 'finished') phase = item.event.final_status.phase;
  return {
    capsuleId,
    runId: item.runId,
    cursor: item.cursor,
    event: item.event.type,
    ...(phase === undefined ? {} : { phase }),
  };
}

function printSnapshot(capsuleId, snapshot) {
  console.log(
    JSON.stringify({
      capsuleId,
      runId: snapshot.status.currentRunId ?? null,
      cursor: snapshot.atCursor ?? null,
      phase: snapshot.status.phase,
    })
  );
}

function watchParams(snapshot) {
  return {
    ...(snapshot.status.currentRunId === null || snapshot.status.currentRunId === undefined
      ? {}
      : { runId: snapshot.status.currentRunId }),
    ...(snapshot.atCursor === undefined ? {} : { fromCursor: snapshot.atCursor }),
  };
}

async function reportCleanupFailure(label, cleanup) {
  try {
    await cleanup();
  } catch {
    console.log(`Live capsule ${label} failed; RunIntent status remains authoritative.`);
  }
}

async function watchCapsule(coordinator, capsuleId, snapshot, signal) {
  const watch = await coordinator.watch({
    params: watchParams(snapshot),
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    for await (const item of watch) {
      console.log(JSON.stringify(safeWatchProjection(capsuleId, item)));
      if (item.type === 'event' && item.event.type === 'finished') return;
    }
  } finally {
    await reportCleanupFailure('watch cancellation', () => watch.cancel());
  }
}

async function observeCapsule(service, context, intent, signal) {
  const capsuleId = intent.capsule_id;
  const coordinator = service.coordinatorFor({
    adapter: context.adapter,
    capsuleId,
    targetAuthority: context.target.url,
  });
  try {
    const session = await coordinator.open(signal);
    const snapshot = await session.client.get({}, signal === undefined ? undefined : { signal });
    printSnapshot(capsuleId, snapshot);
    if (snapshot.status.phase === 'finished') return;
    await watchCapsule(coordinator, capsuleId, snapshot, signal);
  } catch (error) {
    const interrupted = signal?.aborted || error?.name === 'AbortError';
    if (!interrupted) {
      console.log('Live capsule observation disconnected; RunIntent status remains authoritative.');
    }
  } finally {
    await reportCleanupFailure('coordinator cleanup', () => coordinator.close());
  }
}

async function followHostedRun(service, observation) {
  const { context, client, initial, signal } = observation;
  const attachable = await service.observeRunIntent(
    client,
    initial,
    observationOptions(service, signal, {
      until: (intent) => intent.state === 'running' && intent.capsule_id !== null,
    })
  );
  if (TERMINAL_STATES.has(attachable.state)) return finishRunIntent(attachable);

  const liveAbort = new AbortController();
  const liveSignal =
    signal === undefined
      ? liveAbort.signal
      : globalThis.AbortSignal.any([signal, liveAbort.signal]);
  const live = observeCapsule(service, context, attachable, liveSignal);
  try {
    const terminal = await service.followRunIntent(
      client,
      attachable,
      observationOptions(service, signal)
    );
    return finishRunIntent(terminal);
  } finally {
    liveAbort.abort(new globalThis.DOMException('RunIntent observation completed', 'AbortError'));
    await live;
  }
}

async function submitRun(service, options, prepared, signal) {
  const execution = buildRunIntentExecution(prepared.inputs);
  const client = service.runIntentClientFor(prepared.context);
  if (
    options.size !== undefined &&
    !prepared.context.descriptor.sizes.catalog.includes(options.size)
  ) {
    throw new Error('capsule size is not advertised by the target');
  }
  const runtime = await service.runtimeBundleFor(prepared.context.target, {
    mode: options.ship ? 'ship' : 'pr',
    clusterConfigPath: options.config,
  });
  const submissionKey = options.submissionKey ?? service.randomUUID();
  console.log(`Submission key: ${submissionKey}`);
  let created;
  try {
    created = await client.submit({
      envelope: buildRunIntentEnvelope(execution.graph, execution.input),
      runtime,
      submissionKey,
      title: options.title,
      ...(options.size === undefined ? {} : { size: options.size }),
      signal,
    });
  } catch (error) {
    if (isDeterministicSubmissionError(error)) throw error;
    throw submissionUncertain(submissionKey, error);
  }
  return { client, created };
}

async function remoteRun(service, options) {
  const inputs = await service.inputReader(
    options.graph,
    options.input,
    service.runtime.cluster.assertGraphSpec
  );
  const context = await service.contextFor(options.target);
  return withInterruptSignal(async (signal) => {
    const { client, created } = await submitRun(service, options, { context, inputs }, signal);
    console.log(`Run ${created.intent_id} submitted`);
    console.log(`Resume: ${resumeCommand(options.target, created.intent_id)}`);
    if (options.detach) return created;
    console.log('Ctrl+C detaches without cancelling.');
    try {
      return await followHostedRun(service, { context, client, initial: created, signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      console.log(`Detached; run ${created.intent_id} was not cancelled.`);
      return created;
    }
  });
}

async function remoteAttach(service, targetName, intentId) {
  const context = await service.contextFor(targetName);
  const client = service.runIntentClientFor(context);
  return withInterruptSignal(async (signal) => {
    const initial = await client.get(intentId, { signal });
    console.log(`Attached to ${intentId}; Ctrl+C detaches without cancelling.`);
    console.log(`Resume: ${resumeCommand(targetName, intentId)}`);
    try {
      return await followHostedRun(service, { context, client, initial, signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      console.log(`Detached; run ${intentId} was not cancelled.`);
      return initial;
    }
  });
}

async function runIntentStatus(service, targetName, intentId, options) {
  const context = await service.contextFor(targetName);
  const intent = await service.runIntentClientFor(context).get(intentId);
  if (options.json) console.log(JSON.stringify(intent, null, 2));
  else printRunIntentState(intent);
  return intent;
}

function createRunIntentServices(service) {
  return {
    remoteRun: (options) => remoteRun(service, options),
    remoteAttach: (targetName, intentId) => remoteAttach(service, targetName, intentId),
    runIntentStatus: (targetName, intentId, options) =>
      runIntentStatus(service, targetName, intentId, options),
    runIntentCancel: async (targetName, intentId) => {
      const context = await service.contextFor(targetName);
      const intent = await service.runIntentClientFor(context).cancel(intentId);
      printRunIntentState(intent);
      return intent;
    },
  };
}

module.exports = { createRunIntentServices, defaultRunIntentClient };
