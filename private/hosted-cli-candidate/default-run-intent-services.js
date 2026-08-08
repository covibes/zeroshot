'use strict';
const { withInterruptSignal } = require('./interrupt-signal');
const { buildQueuedHostedExecution } = require('./queued-execution');
const {
  RunIntentClient,
  RunIntentHttpError,
  RunIntentRequestError,
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

function followOptions(service, signal) {
  return {
    signal,
    ...(service.dependencies.runIntentSleep === undefined
      ? {}
      : { sleep: service.dependencies.runIntentSleep }),
    onChange: printRunIntentState,
  };
}

async function submitQueuedRun(service, options, prepared, signal) {
  const execution = buildQueuedHostedExecution(prepared.inputs);
  const client = service.runIntentClientFor(prepared.context);
  if (
    options.size !== undefined &&
    !prepared.context.descriptor.sizes.catalog.includes(options.size)
  ) {
    throw new Error('capsule size is not advertised by the target');
  }
  const runtime = await service.runtimeBundleFor(prepared.context.target, {
    mode: options.ship ? 'ship' : 'pr',
  });
  const submissionKey = options.submissionKey ?? service.randomUUID();
  console.log(`Submission key: ${submissionKey}`);
  let created;
  try {
    created = await client.submit({
      envelope: buildRunIntentEnvelope(execution.graph, execution.input),
      runtime,
      submissionKey,
      ...(options.size === undefined ? {} : { size: options.size }),
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
  return withInterruptSignal(async (signal) => {
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
  return withInterruptSignal(async (signal) => {
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

function createRunIntentServices(service) {
  return {
    remoteQueueRun: (options) => remoteQueueRun(service, options),
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
