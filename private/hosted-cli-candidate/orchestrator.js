'use strict';

const crypto = require('node:crypto');
const {
  buildHostedExecution,
  buildLegacyShipRequest,
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

function mustPreserveCapsule(options, ownership, error) {
  return (
    options.signal?.aborted || ownership.uncertain || error instanceof HostedTransportUncertainError
  );
}

class HostedRunOrchestrator {
  constructor(options) {
    this.assertGraphSpec = options.assertGraphSpec;
    this.readInputs = options.readInputs;
    this.resolveRuntimeBundle = options.resolveRuntimeBundle;
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
    const prepared = await this.#prepare(options);
    const ownership = {
      capsule: undefined,
      coordinator: undefined,
      uncertain: false,
      canTerminate: false,
    };
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      ownership.capsule = await this.#allocate(options, prepared.identities);
      this.output.stdout(`Capsule: ${ownership.capsule.id}`);
      ownership.canTerminate = true;
      ownership.capsule = await this.#waitReady(options.adapter, ownership.capsule, options.signal);
      return await this.#execute(options, ownership, prepared);
    } catch (error) {
      return await this.#handleFailure(options, ownership, prepared.identities, error);
    } finally {
      await Promise.resolve(ownership.coordinator?.close()).catch(() => undefined);
    }
  }

  async #prepare(options) {
    const inputs = await this.readInputs(
      options.graphPath,
      options.inputPath,
      this.assertGraphSpec
    );
    const runtime = this.resolveRuntimeBundle(options.target);
    const execution = buildHostedExecution(inputs, runtime);
    const identities = stableIdentities(this.randomUUID, this.runtimeImageDigest);
    return { execution, identities, runtime };
  }

  async #allocate(options, identities) {
    this.output.stdout(`Allocation key: ${identities.allocationIdempotencyKey}`);
    try {
      return await options.adapter.allocate(
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
  }

  async #execute(options, ownership, prepared) {
    try {
      await this.#installRuntime(options, ownership.capsule.id, prepared.runtime);
      ownership.coordinator = this.createCoordinator({
        adapter: options.adapter,
        capsuleId: ownership.capsule.id,
        targetAuthority: options.target.url,
      });
      const initial = await ownership.coordinator.open(options.signal);
      await this.#plan(options, initial, prepared.execution.graph);
      const applied = await this.#apply(options, ownership, initial, prepared);
      if (options.detach) {
        return Object.freeze({
          capsuleId: ownership.capsule.id,
          identities: prepared.identities,
          apply: applied,
          detached: true,
        });
      }
      const final = await this.#observe(options, ownership, applied);
      return Object.freeze({
        capsuleId: ownership.capsule.id,
        identities: prepared.identities,
        apply: applied,
        final,
        detached: false,
      });
    } catch (error) {
      if (error instanceof HostedProtocolError && !ownership.uncertain) throw error;
      ownership.uncertain = true;
      ownership.canTerminate = false;
      throw error;
    }
  }

  async #installRuntime(options, capsuleId, runtime) {
    if (
      options.adapter.credentialInstall?.supported !== true ||
      typeof options.adapter.installRuntime !== 'function'
    ) {
      throw new HostedProtocolError('target does not advertise runtime installation');
    }
    const access = await options.adapter.access(capsuleId, options.signal);
    await options.adapter.installRuntime(capsuleId, runtime, access.accessToken, options.signal);
  }

  async #plan(options, initial, graph) {
    const profiles = initial.initializeResult.capabilities.graphProfiles ?? [];
    if (profiles.length !== 1 || profiles[0] !== 'openengine.graph.single-worker/v1') {
      throw new HostedProtocolError('capsule does not advertise the exact single-worker profile');
    }
    const plan = await initial.client.plan(
      { graph },
      options.signal === undefined ? undefined : { signal: options.signal }
    );
    if (!plan.ok || plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new HostedProtocolError('capsule refused the graph during side-effect-free plan');
    }
  }

  async #apply(options, ownership, initial, prepared) {
    ownership.uncertain = true;
    ownership.canTerminate = false;
    this.output.stdout(`Apply key: ${prepared.identities.applyIdempotencyKey}`);
    const applied = await initial.client.apply(
      {
        graph: prepared.execution.graph,
        input: prepared.execution.input,
        idempotencyKey: prepared.identities.applyIdempotencyKey,
        ifGeneration: 0,
      },
      options.signal === undefined ? undefined : { signal: options.signal }
    );
    if (
      !Number.isSafeInteger(applied.generation) ||
      typeof applied.runId !== 'string' ||
      applied.runId.length === 0
    ) {
      throw new Error('apply response omitted the committed generation or run identity');
    }
    this.output.stdout(`Run: ${applied.runId}`);
    return applied;
  }

  async #observe(options, ownership, applied) {
    await this.#watchUntilFinished(options, ownership, applied.runId);
    const final = await this.#readFinalState(options, ownership, applied);
    this.output.stdout(
      JSON.stringify({
        capsuleId: ownership.capsule.id,
        runId: applied.runId,
        generation: applied.generation,
        phase: final.status.phase,
        cursor: final.status.atCursor ?? null,
      })
    );
    return final;
  }

  async #watchUntilFinished(options, ownership, runId) {
    const watch = await ownership.coordinator.watch({
      params: { runId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      for await (const item of watch) {
        this.output.stdout(JSON.stringify(safeWatchProjection(ownership.capsule.id, item)));
        if (item.type === 'event' && item.event.type === 'finished') break;
      }
    } finally {
      await Promise.resolve(watch.cancel()).catch(() => undefined);
    }
  }

  async #readFinalState(options, ownership, applied) {
    const finalSession = await ownership.coordinator.open(options.signal);
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
    return final;
  }

  async #handleFailure(options, ownership, identities, error) {
    if (!ownership.capsule) throw error;
    if (mustPreserveCapsule(options, ownership, error)) {
      const detached = new RemoteDetachedError(ownership.capsule.id, identities, error);
      this.output.stderr(detached.message);
      throw detached;
    }
    if (!ownership.canTerminate) throw error;
    try {
      await options.adapter.terminate(ownership.capsule.id, options.signal);
    } catch (cleanupError) {
      const detached = new RemoteDetachedError(ownership.capsule.id, identities, cleanupError);
      this.output.stderr(detached.message);
      throw detached;
    }
    throw error;
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
  buildHostedExecution,
  buildLegacyShipRequest,
  RemoteAllocationUncertainError,
  HostedRunOrchestrator,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
