'use strict';

const crypto = require('node:crypto');
const {
  HostedProtocolError,
  HostedTransportUncertainError,
  RemoteAllocationUncertainError,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
} = require('./orchestrator-support');

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const READY_POLL_MS = 2000;

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
    const identities = stableIdentities(this.randomUUID, this.runtimeImageDigest);
    if (
      setup.repository !== options.expectedRepository ||
      setup.provider !== options.expectedProvider ||
      setup.modelLevel !== options.expectedModelLevel
    ) {
      throw new Error('target setup does not match the fixed hosted runtime selection');
    }
    let capsule;
    let coordinator;
    let uncertain = false;
    let canTerminate = false;
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

      canTerminate = true;

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
          { graph: inputs.graph },
          options.signal === undefined ? undefined : { signal: options.signal }
        );
        if (!plan.ok || plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          throw new HostedProtocolError('capsule refused the graph during side-effect-free plan');
        }

        uncertain = true;
        canTerminate = false;
        this.output.stdout(`Apply key: ${identities.applyIdempotencyKey}`);
        const applied = await initial.client.apply(
          {
            graph: inputs.graph,
            input: inputs.input,
            idempotencyKey: identities.applyIdempotencyKey,
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
        uncertain = false;
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
        uncertain = true;
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
        uncertain = false;
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
  RemoteAllocationUncertainError,
  HostedRunOrchestrator,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
