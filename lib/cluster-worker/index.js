'use strict';

const { validateLegacyShipRequest } = require('./contracts');
const { cloneJson, deepFreeze } = require('./object-utils');
const { createDeploymentProfileRegistry, DEFAULT_BOUNDS } = require('./profiles');
const {
  CANCELLED,
  assertIsolatedProfile,
  errorOutcome,
  resolveRuntimeDependencies,
  runCancellable,
} = require('./runtime-support');
const {
  acceptEngineStart,
  createEngineStart,
  handleEngineStartFailure,
} = require('./engine-start');
const { releaseEngine, stopEngine } = require('./runtime-engine');
const { LegacyWorkerStateMachine } = require('./state-machine');
const { createTerminalNormalizer } = require('./terminal-normalizer');
const { createWorkerFacade } = require('./worker-internals');

class LegacyClusterWorkerRuntime {
  constructor(dependencies) {
    Object.assign(this, resolveRuntimeDependencies(dependencies));
    this.machine = new LegacyWorkerStateMachine({ clock: this.clock });
    this.startClaimed = false;
    this.profile = null;
    this.timeoutHandle = null;
    this.timeoutGeneration = 0;
    this.executionStartedAt = null;
    this.terminalAuthority = null;
    this.engineStartAttempted = false;
    this.engineStopPromise = null;
    this.engineReleasePromise = null;
    this.preparationController = new AbortController();
    this.terminalClaimed = new Promise((resolve) => {
      this.resolveTerminalClaimed = resolve;
    });
    this.onEngineEvent = createTerminalNormalizer({
      machine: this.machine,
      clock: this.clock,
      artifactReceiptSink: this.artifactReceiptSink,
      getProfile: () => this.profile,
      claimTerminalAuthority: (authority) => this.claimTerminalAuthority(authority),
      failureReceipt: (state, code, reason) => this.failureReceipt(state, code, reason),
      isTerminal: () => this.terminalAuthority !== null || Boolean(this.machine.terminalReceipt),
      terminalClaimed: this.terminalClaimed,
      signal: this.preparationController.signal,
      cancelled: CANCELLED,
      cleanupFailureReporter: this.cleanupFailureReporter,
    });
  }
  clearExecutionTimeout() {
    this.timeoutGeneration += 1;
    if (this.timeoutHandle !== null) {
      try {
        this.timers.clearTimeout(this.timeoutHandle);
      } catch {
        // The generation guard still makes a stale callback inert.
      }
    }
    this.timeoutHandle = null;
  }
  armExecutionTimeout(milliseconds) {
    this.clearExecutionTimeout();
    const generation = this.timeoutGeneration;
    const elapsed = Math.max(0, this.clock() - this.executionStartedAt);
    const remaining = Math.max(0, milliseconds - elapsed);
    this.timeoutHandle = this.timers.setTimeout(() => {
      if (generation !== this.timeoutGeneration) return;
      this.timeoutHandle = null;
      if (this.claimTerminalAuthority('timeout')) {
        this.machine.terminal(this.failureReceipt('timed_out', 'timeout', 'declared_failure'));
        if (this.engineStartAttempted) this.stopEngine().catch(() => undefined);
      }
    }, remaining);
  }
  initialExecutionBound() {
    const milliseconds =
      this.profile?.bounds.executionMs ?? this.profileRegistry?.bounds?.executionMs;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0
      ? milliseconds
      : DEFAULT_BOUNDS.executionMs;
  }
  cancelPreparation() {
    this.preparationController.abort();
  }
  racePreparation(value, cleanup) {
    return runCancellable(value, {
      signal: this.preparationController.signal,
      cleanup,
      reportFailure: this.cleanupFailureReporter,
      failureContext: {
        phase: 'profile_resolution',
        clusterId: this.machine.clusterId,
      },
    });
  }
  failureReceipt(state, code, reason) {
    return {
      state,
      clusterId: this.machine.clusterId,
      finishedAt: this.clock(),
      outcome: errorOutcome(code, reason),
    };
  }
  claimTerminalAuthority(authority) {
    if (this.terminalAuthority !== null || this.machine.terminalReceipt) return false;
    this.terminalAuthority = authority;
    this.clearExecutionTimeout();
    this.cancelPreparation();
    this.resolveTerminalClaimed(CANCELLED);
    return true;
  }
  failEngineStatus() {
    if (this.claimTerminalAuthority('engine:status')) {
      this.machine.terminal(this.failureReceipt('failed', 'crash', 'declared_failure'));
    }
  }
  async prepareStart(request, clusterId, profileResolution) {
    if (!this.profile) {
      const profileContext = Object.freeze({ signal: this.preparationController.signal });
      const resolvedProfile = await this.racePreparation(profileResolution, (profile) =>
        this.profileRegistry.release?.(profile, profileContext)
      );
      if (resolvedProfile === CANCELLED) return CANCELLED;
      this.profile = assertIsolatedProfile(resolvedProfile, request);
    }
    this.armExecutionTimeout(this.profile.bounds.executionMs);
    if (this.terminalAuthority !== null) return CANCELLED;
    return { clusterId };
  }
  async startEngine(request, clusterId) {
    this.engineStartAttempted = true;
    try {
      const resource = await Promise.race([
        createEngineStart(this, request, clusterId),
        this.terminalClaimed,
      ]);
      const status = await acceptEngineStart(this, resource, request, clusterId);
      return status;
    } catch (error) {
      return handleEngineStartFailure(this, error);
    }
  }
  beginLifecycle() {
    const clusterId = this.idFactory();
    if (typeof clusterId !== 'string' || !clusterId) {
      throw new Error('idFactory returned invalid id');
    }
    this.machine.setClusterId(clusterId);
    this.machine.transition('starting');
    this.executionStartedAt = this.clock();
    this.armExecutionTimeout(this.initialExecutionBound());
    return clusterId;
  }
  claimStartRequest(request) {
    if (this.startClaimed) throw new Error('Worker facade permits exactly one start');
    const requestSnapshot = deepFreeze(cloneJson(request));
    validateLegacyShipRequest(requestSnapshot);
    if (requestSnapshot.source === 'artifact' && !this.artifactResolver) {
      throw new Error('ArtifactResolver is required for artifact input');
    }
    // Claim synchronously so concurrent calls cannot allocate two resources.
    this.startClaimed = true;
    return requestSnapshot;
  }
  resolveStartProfile(request) {
    const profileResolution = this.profileRegistry.resolve(
      request.isolationProfile,
      request.providerProfile,
      Object.freeze({ signal: this.preparationController.signal })
    );
    if (!profileResolution || typeof profileResolution.then !== 'function') {
      this.profile = assertIsolatedProfile(profileResolution, request);
    }
    return profileResolution;
  }
  async handleStartFailure(error) {
    if (this.terminalAuthority !== null) {
      if (!this.machine.terminalReceipt) await this.machine.result();
      return this.machine.status();
    }
    if (!this.machine.clusterId) {
      this.startClaimed = false;
      throw error;
    }
    if (this.claimTerminalAuthority('engine:start-setup')) {
      this.machine.terminal(this.failureReceipt('failed', 'crash', 'declared_failure'));
    }
    throw error;
  }
  async start(request) {
    const requestSnapshot = this.claimStartRequest(request);
    try {
      const profileResolution = this.resolveStartProfile(requestSnapshot);
      const clusterId = this.beginLifecycle();
      const prepared = await this.prepareStart(requestSnapshot, clusterId, profileResolution);
      if (prepared === CANCELLED) return this.machine.status();
      return this.startEngine(requestSnapshot, clusterId);
    } catch (error) {
      return this.handleStartFailure(error);
    }
  }
  status() {
    if (
      this.engineStartAttempted &&
      this.machine.clusterId &&
      !this.machine.terminalReceipt &&
      typeof this.engineAdapter.status === 'function'
    ) {
      try {
        const diagnostic = this.engineAdapter.status();
        if (diagnostic && typeof diagnostic.then === 'function') {
          diagnostic.then(undefined, () => this.failEngineStatus());
          throw new TypeError('EngineAdapter.status() must return synchronously');
        }
      } catch (error) {
        this.failEngineStatus();
        if (!this.machine.terminalReceipt) throw error;
      }
    }
    return this.machine.status();
  }
  events() {
    return this.machine.events();
  }
  stopEngine() {
    return stopEngine(this);
  }
  async releaseEngine() {
    await releaseEngine(this);
  }
  async stop() {
    if (!this.startClaimed) throw new Error('Worker has not started');
    if (this.machine.terminalReceipt) {
      const cleanupEffective = this.engineStopPromise ? await this.engineStopPromise : true;
      if (cleanupEffective) await this.releaseEngine();
      return this.machine.terminalReceipt;
    }
    if (!this.claimTerminalAuthority('stop')) return this.machine.result();
    this.machine.requestStop();
    const effective = this.engineStartAttempted ? await this.stopEngine() : true;
    this.machine.terminal({
      state: 'stopped',
      clusterId: this.machine.clusterId,
      finishedAt: this.clock(),
      stop: {
        requested: true,
        effective,
        externalEffectsRolledBack: false,
      },
    });
    if (effective) await this.releaseEngine();
    return this.machine.terminalReceipt;
  }
  result() {
    if (!this.startClaimed) throw new Error('Worker has not started');
    return this.machine.result();
  }
}

function createCurrentEngineAdapter(...args) {
  return require('./engine-adapter').createCurrentEngineAdapter(...args);
}

function createLegacyClusterWorker(dependencies = {}) {
  return createWorkerFacade(new LegacyClusterWorkerRuntime(dependencies));
}

module.exports = {
  createLegacyClusterWorker,
  createDeploymentProfileRegistry,
  createCurrentEngineAdapter,
};
