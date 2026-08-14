'use strict';

const fs = require('node:fs');
const { createCurrentEngineAdapter } = require('../../lib/cluster-worker/engine-adapter');
const {
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
} = require('../../lib/cluster-worker/engine-adapter-common');
const { hydrateIssueRequest } = require('./issue-hydration');
const { prepareWorkspace, shipWorkspace } = require('./workspace-ship');

const WORKSPACE = '/workspace';

function rejectInheritedSockets() {
  for (const descriptor of fs.readdirSync('/proc/self/fd')) {
    if (Number(descriptor) <= 2) continue;
    let target;
    try {
      target = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (target.startsWith('socket:[')) {
      throw new Error('Capsule worker inherited a trusted service descriptor');
    }
  }
}

function requireHostedEnvironment(config) {
  if (process.cwd() !== WORKSPACE) throw new Error('Invalid fixed capsule workspace');
  if (process.env.ZEROSHOT_ISOLATION_PROFILE !== 'isolation.prepared-worktree@1') {
    throw new Error('Invalid fixed capsule isolation profile');
  }
  if (process.env.ZEROSHOT_PROVIDER_PROFILE !== 'provider.hosted-direct@1') {
    throw new Error('Invalid fixed capsule provider profile');
  }
  for (const [name, value] of Object.entries(config.runtimeEnvironment)) {
    if (process.env[name] !== value) throw new Error('Invalid hosted worker runtime boundary');
  }
  rejectInheritedSockets();
}

function validateRequestAuthority(config, request) {
  if (request.repository !== config.repository) {
    const error = new Error('Hosted request repository does not match capsule authority');
    error.code = 'HOSTED_REPOSITORY_MISMATCH';
    throw error;
  }
  if (request.provider !== config.provider) {
    const error = new Error('Hosted request provider does not match capsule authority');
    error.code = 'HOSTED_PROVIDER_MISMATCH';
    throw error;
  }
}

function withholdGitCredentials() {
  const values = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  return () => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function preparedProfile(profile, config, branch) {
  return Object.freeze({
    ...profile,
    deployment: Object.freeze({
      ...profile.deployment,
      preparedWorktree: Object.freeze({
        path: WORKSPACE,
        repoRoot: WORKSPACE,
        branch,
        baseSha: config.baseRevision,
      }),
    }),
  });
}

function legacyShipResult(deliveryResult) {
  return {
    summary: `Hosted worker completed ${deliveryResult.disposition}`,
    status: 'succeeded',
    artifacts: [],
    repository: deliveryResult.repository,
    branch: deliveryResult.deliveryBranch,
    headRevision: deliveryResult.headRevision,
    pullRequestUrl: deliveryResult.pullRequestUrl,
  };
}

class HostedClusterEngineAdapter {
  constructor(config, dependencies = {}) {
    (dependencies.requireHostedEnvironment || requireHostedEnvironment)(config);
    this.config = config;
    this.createEngine = dependencies.createEngine || (() => createCurrentEngineAdapter());
    this.hydrateIssueRequest = dependencies.hydrateIssueRequest || hydrateIssueRequest;
    this.prepareWorkspace = dependencies.prepareWorkspace || prepareWorkspace;
    this.shipWorkspace = dependencies.shipWorkspace || shipWorkspace;
    this.resource = null;
    this.inner = null;
    this.finalization = null;
    this.restoreGitCredentials = null;
    this.closed = false;
    this.innerTerminal = false;
  }

  async start({ request, profile, prepareArtifacts, clusterId, onEvent }) {
    if (this.resource) throw new Error('Hosted cluster adapter owns exactly one run');
    validateRequestAuthority(this.config, request);
    this.resource = { clusterId, onEvent };
    const engineRequest = await this.hydrateIssueRequest(this.config, request);
    const branch = await this.prepareWorkspace(this.config, clusterId);
    this.restoreGitCredentials = withholdGitCredentials();
    this.inner = this.createEngine();
    return this.inner.start({
      request: engineRequest,
      profile: preparedProfile(profile, this.config, branch),
      ...(prepareArtifacts ? { prepareArtifacts } : {}),
      clusterId,
      onEvent: (event) => this.consumeInnerEvent(event, branch),
    });
  }

  consumeInnerEvent(event, branch) {
    if (this.closed || this.innerTerminal) return;
    if (event.type === 'running') {
      this.resource.onEvent(event);
      return;
    }
    this.innerTerminal = true;
    if (event.type === 'complete') {
      this.finalization = this.finishDelivery(branch);
      return;
    }
    this.resource.onEvent(event.type === 'failed' ? event : declaredFailureEvent());
  }

  async finishDelivery(branch) {
    try {
      const stopped = await this.inner.stop();
      if (stopped?.effective === false) throw new Error('Hosted cluster cleanup failed');
      await this.inner.waitForCleanup();
      this.restoreGitCredentials();
      this.restoreGitCredentials = null;
      const deliveryResult = await this.shipWorkspace(this.config, branch);
      if (!this.closed) {
        this.resource.onEvent({ type: 'complete', result: legacyShipResult(deliveryResult) });
      }
    } catch {
      if (!this.closed) this.resource.onEvent(declaredFailureEvent());
    }
  }

  status() {
    if (!this.resource) return null;
    if (this.inner) return this.inner.status();
    return frozenResourceStatus(this.resource, this.closed ? 'released' : 'starting');
  }

  stop() {
    if (!this.resource) throw new Error('Hosted cluster adapter has no run');
    this.closed = true;
    return this.inner ? this.inner.stop() : Object.freeze({ effective: true });
  }

  async waitForCleanup() {
    if (this.finalization) {
      await this.finalization;
      return;
    }
    await this.inner?.waitForCleanup();
  }

  close() {
    this.closed = true;
    this.inner?.close();
  }
}

function createHostedClusterEngineAdapter(config, dependencies) {
  return createAdapterFacade(new HostedClusterEngineAdapter(config, dependencies));
}

module.exports = {
  createHostedClusterEngineAdapter,
  preparedProfile,
  validateRequestAuthority,
  withholdGitCredentials,
};
