'use strict';

const { cloneJson } = require('./object-utils');
const { inputFromRequest } = require('./engine-input');
const {
  completionSummary,
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
} = require('./engine-adapter-common');

const TERMINAL_TOPICS = new Set(['CLUSTER_COMPLETE', 'CLUSTER_FAILED']);

function messageKey(message) {
  return message.id ?? `${message.timestamp}:${message.topic}:${message.sender}`;
}

function completionPayload(data) {
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(data, 'result')) payload.result = data.result;
  if (Object.prototype.hasOwnProperty.call(data, 'artifacts')) payload.artifacts = data.artifacts;
  return payload;
}

function terminalEventFromMessage(message) {
  const data = message.content?.data || {};
  if (message.topic === 'CLUSTER_COMPLETE') {
    return {
      type: 'complete',
      summary: completionSummary(data.reason || message.content?.text),
      ...completionPayload(data),
    };
  }
  return {
    type: 'failed',
    summary: data.reason || message.content?.text,
    code: data.code,
    reason: data.workerReason,
  };
}

function resolveOrchestrator(options) {
  if (options.orchestrator) return options.orchestrator;
  const Orchestrator = options.Orchestrator || require('../../src/orchestrator');
  return new Orchestrator({
    quiet: true,
    ...(options.storageDir ? { storageDir: options.storageDir } : {}),
    skipLoad: true,
  });
}

class CurrentEngineAdapter {
  constructor(options) {
    this.options = options;
    this.orchestrator = options.orchestrator || null;
    this.startCluster = options.startCluster || null;
    this.resource = null;
    this.startPromise = null;
    this.startSettled = false;
    this.stopPromise = null;
    this.cleanupPromise = null;
    this.allocatedStopPromise = null;
    this.stopRequested = false;
    this.closed = false;
    this.unsubscribe = null;
    this.seen = new Set();
    this.terminalObserved = false;
    this.foldScheduled = false;
  }

  ensureRuntime() {
    this.orchestrator ||= resolveOrchestrator(this.options);
    this.startCluster ||= require('../start-cluster');
  }

  loadConfig(profile) {
    const provider = profile.provider;
    if (provider.config) {
      const prepareClusterConfig =
        this.startCluster.prepareClusterConfig || require('../start-cluster').prepareClusterConfig;
      const config = prepareClusterConfig(
        cloneJson(provider.config),
        provider.settings || {},
        provider.providerOverride || undefined
      );
      if (provider.validateConfig === true) {
        const validation = this.orchestrator.validateConfig(config);
        if (!validation.valid) {
          throw new Error(`Invalid config:\n  ${validation.errors.join('\n  ')}`);
        }
      }
      return config;
    }
    return this.startCluster.loadClusterConfig(
      this.orchestrator,
      provider.configPath || this.startCluster.resolveConfigPath(provider.configName),
      provider.settings || {},
      provider.providerOverride || undefined
    );
  }

  startOptions(profile, clusterId) {
    const provider = profile.provider;
    return this.startCluster.buildTrustedStartOptions({
      clusterId,
      plan: profile.plan,
      options: profile.deployment,
      settings: provider.settings || {},
      providerOverride: provider.providerOverride || undefined,
      modelOverride: provider.modelOverride || undefined,
      forceProvider: provider.forceProvider || undefined,
    });
  }

  consume(message) {
    if (
      this.terminalObserved ||
      message.cluster_id !== this.resource.clusterId ||
      !TERMINAL_TOPICS.has(message.topic)
    ) {
      return;
    }
    const key = messageKey(message);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.terminalObserved = true;
    this.resource.onEvent(terminalEventFromMessage(message));
  }

  foldDurableMessages() {
    if (!this.resource.messageBus) return;
    for (const message of this.resource.messageBus.getAll(this.resource.clusterId)) {
      this.consume(message);
    }
  }

  scheduleDurableFold(message) {
    if (message.cluster_id !== this.resource.clusterId || !TERMINAL_TOPICS.has(message.topic)) {
      return;
    }
    if (this.foldScheduled || this.terminalObserved) return;
    this.foldScheduled = true;
    Promise.resolve().then(() => {
      this.foldScheduled = false;
      if (!this.resource || this.terminalObserved) return;
      try {
        this.foldDurableMessages();
      } catch {
        this.resource.onEvent(declaredFailureEvent());
      }
    });
  }

  async start({ request, profile, prepareArtifacts, clusterId, onEvent }) {
    if (this.resource) throw new Error('Engine adapter owns one cluster resource');
    this.ensureRuntime();
    const config = this.loadConfig(profile);
    const artifactInput = request.source === 'artifact';
    if (artifactInput && typeof prepareArtifacts !== 'function') {
      throw new Error('Artifact engine start requires prepareArtifacts()');
    }
    const input = artifactInput
      ? { text: 'Artifact input is being prepared inside the allocated isolation.' }
      : inputFromRequest(request);
    const startOptions = this.startOptions(profile, clusterId);
    let artifactsStaged = !artifactInput;
    const options = artifactInput
      ? {
          ...startOptions,
          async prepareIsolatedInput({ isolation }) {
            const artifactManifest = await prepareArtifacts(isolation);
            if (
              !artifactManifest ||
              typeof artifactManifest !== 'object' ||
              Array.isArray(artifactManifest)
            ) {
              throw new Error('ArtifactResolver returned an invalid staged manifest');
            }
            artifactsStaged = true;
            return inputFromRequest(request, artifactManifest).text;
          },
        }
      : startOptions;
    this.resource = {
      clusterId,
      messageBus: null,
      onEvent,
      shutdownMs: profile.bounds?.shutdownMs || 30_000,
    };
    try {
      this.startPromise = Promise.resolve(this.orchestrator.start(config, input, options));
      const started = await this.startPromise;
      this.resource.clusterId = started.id;
      this.resource.messageBus = started.messageBus;
      this.unsubscribe = started.messageBus.subscribe((message) =>
        this.scheduleDurableFold(message)
      );
      if (this.stopRequested) {
        const stopResult = await this.stopPromise;
        if (!stopResult.effective) await this.stopAllocatedCluster();
      } else {
        onEvent({ type: 'running' });
      }
      this.foldDurableMessages();
      return Object.freeze({ clusterId: started.id, artifactsStaged });
    } finally {
      this.startSettled = true;
    }
  }

  foldClusterState(cluster) {
    if (!cluster) {
      if (!this.terminalObserved) {
        this.resource.onEvent(declaredFailureEvent());
      }
      return 'released';
    }
    if (!this.terminalObserved && ['failed', 'stopped', 'killed'].includes(cluster.state)) {
      this.resource.onEvent(declaredFailureEvent());
    } else if (cluster.state === 'running') {
      this.resource.onEvent({ type: 'running' });
    }
    return cluster.state;
  }

  status() {
    if (!this.resource) return null;
    this.foldDurableMessages();
    const cluster = this.orchestrator.getCluster(this.resource.clusterId);
    if (!cluster && !this.startSettled) {
      return frozenResourceStatus(this.resource, 'starting');
    }
    const state = this.foldClusterState(cluster);
    if (!cluster) return frozenResourceStatus(this.resource, state);
    return frozenResourceStatus(this.resource, state, {
      messageCount: cluster.ledger.count({ cluster_id: this.resource.clusterId }),
      pidAliveDiagnostic: this.orchestrator.getStatus(this.resource.clusterId).isZombie !== true,
    });
  }

  stop() {
    if (!this.resource) throw new Error('Engine adapter has no cluster resource');
    this.stopRequested = true;
    this.stopPromise ||= this.stopResource();
    return this.stopPromise;
  }
  async waitForAllocatedCluster() {
    let cluster = this.orchestrator.getCluster(this.resource.clusterId);
    while (!cluster && !this.startSettled && !this.closed) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      cluster = this.orchestrator.getCluster(this.resource.clusterId);
    }
    return cluster;
  }
  stopAllocatedCluster(cluster = this.orchestrator.getCluster(this.resource.clusterId)) {
    if (!cluster) return Promise.resolve(false);
    if (cluster.state === 'stopped' || cluster.state === 'killed') return Promise.resolve(true);
    this.allocatedStopPromise ||= Promise.resolve()
      .then(() => this.orchestrator.stop(this.resource.clusterId))
      .then(() => true);
    return this.allocatedStopPromise;
  }
  async stopResource() {
    this.cleanupPromise ||= this.waitForAllocatedCluster()
      .then((cluster) => this.stopAllocatedCluster(cluster))
      .catch(() => false)
      .then((effective) => {
        this.close();
        return effective;
      });
    let deadlineHandle;
    const deadline = new Promise((resolve) => {
      deadlineHandle = setTimeout(() => resolve(false), this.resource.shutdownMs);
    });
    const effective = await Promise.race([this.cleanupPromise, deadline]);
    clearTimeout(deadlineHandle);
    return { effective };
  }

  waitForCleanup() {
    return this.cleanupPromise || Promise.resolve();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.orchestrator?.close();
  }
}

function createCurrentEngineAdapter(options = {}) {
  return createAdapterFacade(new CurrentEngineAdapter(options));
}

module.exports = { createCurrentEngineAdapter, inputFromRequest, terminalEventFromMessage };
