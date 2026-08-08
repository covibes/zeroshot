'use strict';

const fs = require('node:fs');
const { runProviderExecutable } = require('../../lib/agent-cli-provider');
const {
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
  requestText,
} = require('../../lib/cluster-worker/engine-adapter-common');
const { prepareWorkspace, shipWorkspace } = require('./workspace-ship');

const WORKSPACE = '/workspace';
const PROVIDER_TIMEOUT_MS = 60 * 60 * 1000;

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

function providerPrompt(request) {
  return [
    'Complete the requested task by modifying the current Git workspace.',
    'Do not commit, push, create a pull request, or expose environment credentials.',
    'The hosted runtime performs and verifies Git delivery after your process exits successfully.',
    requestText(request, 'Complete the task represented by the prepared artifact inputs.'),
  ].join('\n\n');
}

function providerInvocation(config, request) {
  const modelSpec = config.model === undefined ? {} : { model: config.model };
  return Object.freeze({
    schemaVersion: 1,
    command: 'invoke',
    provider: config.executable,
    context: providerPrompt(request),
    cwd: WORKSPACE,
    options: Object.freeze({
      ...(config.executable === 'omp' ? {} : { authEnv: config.runtimeEnvironment }),
      autoApprove: true,
      cwd: WORKSPACE,
      executionContext: 'docker',
      ...(config.model === undefined ? {} : { modelSpec: Object.freeze(modelSpec) }),
    }),
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
}

async function withoutGitCredential(operation) {
  const gitToken = process.env.GH_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    return await operation();
  } finally {
    if (gitToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = gitToken;
    if (githubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = githubToken;
  }
}

class HostedProviderEngineAdapter {
  constructor(config, dependencies = {}) {
    requireHostedEnvironment(config);
    this.config = config;
    this.invokeProvider = dependencies.invokeProvider || runProviderExecutable;
    this.prepareWorkspace = dependencies.prepareWorkspace || prepareWorkspace;
    this.shipWorkspace = dependencies.shipWorkspace || shipWorkspace;
    this.resource = null;
    this.execution = null;
    this.closed = false;
  }

  start({ request, clusterId, onEvent }) {
    if (this.resource) throw new Error('Hosted provider adapter owns exactly one run');
    validateRequestAuthority(this.config, request);
    this.resource = { clusterId, onEvent };
    this.execution = this.execute(request, clusterId);
    onEvent({ type: 'running' });
    return Object.freeze({ clusterId, artifactsStaged: true });
  }

  async execute(request, clusterId) {
    try {
      const branch = await this.prepareWorkspace(this.config, clusterId);
      const response = await withoutGitCredential(() =>
        this.invokeProvider(JSON.stringify(providerInvocation(this.config, request)), {
          runtimeSettings: this.config.settings,
        })
      );
      const result = response?.envelope?.ok === true ? response.envelope.result : null;
      if (
        response?.exitCode !== 0 ||
        !result ||
        result.exitCode !== 0 ||
        result.signal !== null ||
        result.timedOut === true ||
        result.classification !== null
      ) {
        throw new Error('Hosted provider execution failed');
      }
      if (this.closed) return;
      const deliveryResult = await this.shipWorkspace(this.config, branch);
      const receipt = {
        repository: deliveryResult.repository,
        branch: deliveryResult.deliveryBranch,
        headRevision: deliveryResult.headRevision,
        pullRequestUrl: deliveryResult.pullRequestUrl,
      };
      if (!this.closed) {
        this.resource.onEvent({
          type: 'complete',
          result: {
            summary: `Hosted worker completed ${deliveryResult.disposition}`,
            status: 'succeeded',
            artifacts: [],
            ...receipt,
          },
        });
      }
    } catch {
      if (!this.closed) this.resource.onEvent(declaredFailureEvent());
    }
  }

  status() {
    if (!this.resource) return null;
    return frozenResourceStatus(this.resource, this.closed ? 'released' : 'running');
  }

  stop() {
    if (!this.resource) throw new Error('Hosted provider adapter has no run');
    this.closed = true;
    return Object.freeze({ effective: true });
  }

  async waitForCleanup() {
    await this.execution;
  }

  close() {
    this.closed = true;
  }
}

function createHostedProviderEngineAdapter(config, dependencies) {
  return createAdapterFacade(new HostedProviderEngineAdapter(config, dependencies));
}

module.exports = {
  providerInvocation,
  createHostedProviderEngineAdapter,
  validateRequestAuthority,
  withoutGitCredential,
};
