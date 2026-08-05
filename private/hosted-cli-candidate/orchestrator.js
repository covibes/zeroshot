'use strict';

const crypto = require('node:crypto');
const { validateLegacyShipRequest } = require('../../lib/cluster-worker/contracts');
const {
  HostedProtocolError,
  HostedTransportUncertainError,
  isDeterministicAllocationRefusal,
  RemoteAllocationUncertainError,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
} = require('./orchestrator-support');

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const READY_POLL_MS = 2000;
const ISOLATION_PROFILE = 'isolation.prepared-worktree@1';
const PROVIDER_PROFILE = 'provider.hosted-direct@1';
const AUTHORITY_REFUSAL_CODES = new Set(['HOSTED_REPOSITORY_MISMATCH', 'HOSTED_PROVIDER_MISMATCH']);

function authorityRefusalCode(error) {
  const code = error?.data?.code ?? error?.code;
  return AUTHORITY_REFUSAL_CODES.has(code) ? code : undefined;
}

function buildLegacyShipRequest(input, setup) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('hosted input must be a LegacyShipRequest object');
  }
  if (input.source === 'artifact') {
    throw new Error('hosted artifact input is unavailable without trusted artifact staging');
  }
  const authority = Object.freeze({
    isolationProfile: ISOLATION_PROFILE,
    providerProfile: PROVIDER_PROFILE,
    repository: setup.repository,
    provider: setup.provider,
    modelLevel: setup.modelLevel,
  });
  for (const [field, value] of Object.entries(authority)) {
    if (Object.hasOwn(input, field) && input[field] !== value) {
      throw new Error(`hosted input ${field} does not match the fixed server authority`);
    }
  }
  const request = { ...input, ...authority };
  validateLegacyShipRequest(request);
  return Object.freeze(request);
}

function assertHostedSelection(setup, expected) {
  if (
    setup.repository !== expected.repository ||
    setup.provider !== expected.provider ||
    setup.modelLevel !== expected.modelLevel
  ) {
    throw new Error('target setup does not match the fixed hosted runtime selection');
  }
}

function buildHostedExecution(inputs, setup, expected) {
  assertHostedSelection(setup, expected);
  return Object.freeze({
    graph: inputs.graph,
    input: buildLegacyShipRequest(inputs.input, setup),
  });
}

class HostedRunOrchestrator {
  constructor(options) {
    this.assertGraphSpec = options.assertGraphSpec;
    this.readInputs = options.readInputs;
    this.checkHostedSetup = options.checkHostedSetup;
    this.createCoordinator = options.createCoordinator;
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    this.runtimeImageDigest = options.runtimeImageDigest;
    this.clock = options.clock ?? Date;
    this.sleep = options.sleep ?? sleep;
    this.output = options.output ?? {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    };
  }

  async run(options) {
    const inputs = await this.readInputs(
      options.graphPath,
      options.inputPath,
      this.assertGraphSpec
    );
    const setup = this.checkHostedSetup(options.target);
    const execution = buildHostedExecution(inputs, setup, {
      repository: options.expectedRepository,
      provider: options.expectedProvider,
      modelLevel: options.expectedModelLevel,
    });
    const identities = stableIdentities(this.randomUUID, this.runtimeImageDigest);
    let capsule;
    let coordinator;
    let uncertain = false;
    let canTerminate = false;
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      this.output.stdout(`Allocation key: ${identities.allocationIdempotencyKey}`);
      try {
        capsule = await options.adapter.allocate(
          {
            idempotencyKey: identities.allocationIdempotencyKey,
            label: `zeroshot-${identities.clientRunId.slice(-12)}`,
          },
          options.signal
        );
      } catch (error) {
        if (isDeterministicAllocationRefusal(error)) throw error;
        const allocationError = new RemoteAllocationUncertainError(
          identities.allocationIdempotencyKey,
          error
        );
        this.output.stderr(allocationError.message);
        throw allocationError;
      }
      this.output.stdout(`Capsule: ${capsule.id}`);
      canTerminate = true;
      capsule = await this.#waitReady(options.adapter, capsule, options.signal);

      try {
        coordinator = this.createCoordinator({
          adapter: options.adapter,
          capsuleId: capsule.id,
          targetAuthority: options.target.url,
        });
        const initial = await coordinator.open(options.signal);
        const profiles = initial.initializeResult.capabilities.graphProfiles ?? [];
        if (profiles.length !== 1 || profiles[0] !== 'openengine.graph.single-worker/v1') {
          throw new HostedProtocolError(
            'capsule does not advertise the exact single-worker profile'
          );
        }
        const plan = await initial.client.plan(
          { graph: execution.graph },
          options.signal === undefined ? undefined : { signal: options.signal }
        );
        if (!plan.ok || plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          throw new HostedProtocolError('capsule refused the graph during side-effect-free plan');
        }

        uncertain = true;
        canTerminate = false;
        this.output.stdout(`Apply key: ${identities.applyIdempotencyKey}`);
        let applied;
        try {
          applied = await initial.client.apply(
            {
              graph: execution.graph,
              input: execution.input,
              idempotencyKey: identities.applyIdempotencyKey,
              ifGeneration: 0,
            },
            options.signal === undefined ? undefined : { signal: options.signal }
          );
        } catch (error) {
          const code = authorityRefusalCode(error);
          if (code !== undefined) {
            uncertain = false;
            canTerminate = true;
            throw new HostedProtocolError(`capsule refused fixed hosted authority (${code})`);
          }
          throw error;
        }
        if (
          !Number.isSafeInteger(applied.generation) ||
          typeof applied.runId !== 'string' ||
          applied.runId.length === 0
        ) {
          throw new Error('apply response omitted the committed generation or run identity');
        }
        this.output.stdout(`Run: ${applied.runId}`);
        if (options.detach) {
          return Object.freeze({
            capsuleId: capsule.id,
            identities,
            apply: applied,
            detached: true,
          });
        }

        const watch = await coordinator.watch({
          params: { runId: applied.runId },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        try {
          for await (const item of watch) {
            this.output.stdout(JSON.stringify(safeWatchProjection(capsule.id, item)));
            if (item.type === 'event' && item.event.type === 'finished') {
              break;
            }
          }
        } finally {
          await Promise.resolve(watch.cancel()).catch(() => undefined);
        }

        const finalSession = await coordinator.open(options.signal);
        const final = await finalSession.client.get(
          {},
          options.signal === undefined ? undefined : { signal: options.signal }
        );
        if (
          final.status.currentRunId !== applied.runId ||
          final.status.observedGeneration !== applied.generation ||
          final.status.phase !== 'finished'
        ) {
          throw new Error('authoritative final state is not terminal for the committed run');
        }
        this.output.stdout(
          JSON.stringify({
            capsuleId: capsule.id,
            runId: applied.runId,
            generation: applied.generation,
            phase: final.status.phase,
            cursor: final.status.atCursor ?? null,
          })
        );
        return Object.freeze({
          capsuleId: capsule.id,
          identities,
          apply: applied,
          final,
          detached: false,
        });
      } catch (error) {
        if (error instanceof HostedProtocolError && !uncertain) throw error;
        uncertain = true;
        canTerminate = false;
        throw error;
      }
    } catch (error) {
      if (!capsule) throw error;
      if (options.signal?.aborted || uncertain || error instanceof HostedTransportUncertainError) {
        const detached = new RemoteDetachedError(capsule.id, identities, error);
        this.output.stderr(detached.message);
        throw detached;
      }
      if (canTerminate) {
        try {
          await options.adapter.terminate(capsule.id, options.signal);
        } catch (cleanupError) {
          const detached = new RemoteDetachedError(capsule.id, identities, cleanupError);
          this.output.stderr(detached.message);
          throw detached;
        }
      }
      throw error;
    } finally {
      await Promise.resolve(coordinator?.close()).catch(() => undefined);
    }
  }

  async #waitReady(adapter, initial, signal) {
    const deadline = this.clock.now() + READY_TIMEOUT_MS;
    let capsule = initial;
    while (capsule.state === 'provisioning') {
      if (this.clock.now() >= deadline) {
        throw new HostedTransportUncertainError('capsule readiness timed out');
      }
      await this.sleep(READY_POLL_MS, signal);
      try {
        capsule = await adapter.inspect(capsule.id, signal);
      } catch (error) {
        throw new HostedTransportUncertainError('capsule readiness outcome is unknown', error);
      }
    }
    if (capsule.state !== 'ready') {
      throw new HostedProtocolError(
        `capsule entered terminal host state ${capsule.state} before readiness`
      );
    }
    return capsule;
  }
}

module.exports = {
  assertHostedSelection,
  buildHostedExecution,
  buildLegacyShipRequest,
  ISOLATION_PROFILE,
  PROVIDER_PROFILE,
  RemoteAllocationUncertainError,
  HostedRunOrchestrator,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
