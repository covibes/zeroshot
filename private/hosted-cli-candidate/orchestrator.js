'use strict';

const crypto = require('node:crypto');
const { InstallProtocolError, InstallTransportUncertainError } = require('./install-client');

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const READY_POLL_MS = 2000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

class RemoteDetachedError extends Error {
  constructor(capsuleId, identities, cause) {
    super(
      `remote outcome is uncertain; capsule ${capsuleId} was preserved. ` +
        `Inspect with \`zeroshot status ${capsuleId} --target <name>\` and terminate only with ` +
        `\`zeroshot capsule terminate ${capsuleId} --target <name>\`.`,
      { cause }
    );
    this.name = 'RemoteDetachedError';
    this.capsuleId = capsuleId;
    this.identities = identities;
  }
}

function stableIdentities(randomUUID, runtimeImageDigest) {
  if (!DIGEST_PATTERN.test(runtimeImageDigest)) {
    throw new Error('candidate runtime image digest is missing or invalid');
  }
  const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
  return Object.freeze({
    allocationIdempotencyKey: id('allocate'),
    installIdempotencyKey: id('install'),
    applyIdempotencyKey: id('apply'),
    clientRunId: id('run'),
    runtimeImageDigest,
  });
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('operation aborted', 'AbortError');
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  const phase =
    item.event.type === 'phase'
      ? item.event.status.phase
      : item.event.type === 'finished'
        ? item.event.final_status.phase
        : undefined;
  return {
    capsuleId,
    runId: item.runId,
    cursor: item.cursor,
    event: item.event.type,
    ...(phase === undefined ? {} : { phase }),
  };
}

class HostedRunOrchestrator {
  constructor(options) {
    this.assertGraphSpec = options.assertGraphSpec;
    this.readInputs = options.readInputs;
    this.checkCredentialSources = options.checkCredentialSources;
    this.readCredentials = options.readCredentials;
    this.installClient = options.installClient;
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
    const setup = await this.checkCredentialSources(options.target, options.credentialStore);
    const identities = stableIdentities(this.randomUUID, this.runtimeImageDigest);
    let capsule;
    let coordinator;
    let uncertain = false;
    let canTerminate = false;
    try {
      capsule = await options.adapter.allocate(
        {
          idempotencyKey: identities.allocationIdempotencyKey,
          label: `zeroshot-${identities.clientRunId.slice(-12)}`,
        },
        options.signal
      );
      this.output.stdout(`Capsule: ${capsule.id}`);
      canTerminate = true;
      capsule = await this.#waitReady(options.adapter, capsule, options.signal);

      const credentials = await this.readCredentials(options.target, options.credentialStore);
      try {
        await this.installClient.install({
          adapter: options.adapter,
          descriptor: options.descriptor,
          sessionManager: options.sessionManager,
          credentials,
          identities,
          setup,
          capsuleId: capsule.id,
          organizationId: options.target.organization.id,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onUploadStart: () => {
            uncertain = true;
            canTerminate = false;
          },
        });
      } finally {
        credentials.githubToken.fill(0);
        credentials.openrouterKey.fill(0);
      }
      uncertain = false;
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
          throw new InstallProtocolError(
            'capsule does not advertise the exact single-worker profile'
          );
        }
        const plan = await initial.client.plan(
          { graph: inputs.graph },
          options.signal === undefined ? undefined : { signal: options.signal }
        );
        if (!plan.ok || plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          throw new InstallProtocolError('capsule refused the graph during side-effect-free plan');
        }

        uncertain = true;
        canTerminate = false;
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
        this.output.stdout(`Apply key: ${identities.applyIdempotencyKey}`);
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
        let observedFinished = false;
        try {
          for await (const item of watch) {
            this.output.stdout(JSON.stringify(safeWatchProjection(capsule.id, item)));
            if (item.type === 'event' && item.event.type === 'finished') {
              observedFinished = true;
              break;
            }
          }
        } finally {
          await watch.cancel().catch(() => undefined);
        }

        const finalSession = await coordinator.open(options.signal);
        const final = await finalSession.client.get(
          {},
          options.signal === undefined ? undefined : { signal: options.signal }
        );
        if (
          final.status.currentRunId !== applied.runId ||
          final.status.observedGeneration !== applied.generation ||
          (!observedFinished && final.status.phase !== 'finished')
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
        if (error instanceof InstallProtocolError && !uncertain) throw error;
        uncertain = true;
        canTerminate = false;
        throw error;
      }
    } catch (error) {
      if (!capsule) throw error;
      if (options.signal?.aborted || uncertain || error instanceof InstallTransportUncertainError) {
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
      await coordinator?.close().catch(() => undefined);
    }
  }

  async #waitReady(adapter, initial, signal) {
    const deadline = this.clock.now() + READY_TIMEOUT_MS;
    let capsule = initial;
    while (capsule.state === 'provisioning') {
      if (this.clock.now() >= deadline) {
        throw new InstallTransportUncertainError('capsule readiness timed out');
      }
      await this.sleep(READY_POLL_MS, signal);
      try {
        capsule = await adapter.inspect(capsule.id, signal);
      } catch (error) {
        throw new InstallTransportUncertainError('capsule readiness outcome is unknown', error);
      }
    }
    if (capsule.state !== 'ready') {
      throw new InstallProtocolError(
        `capsule entered terminal host state ${capsule.state} before install`
      );
    }
    return capsule;
  }
}

module.exports = {
  HostedRunOrchestrator,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  RemoteDetachedError,
  safeWatchProjection,
  sleep,
  stableIdentities,
};
