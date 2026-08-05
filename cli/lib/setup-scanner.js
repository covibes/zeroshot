const path = require('path');
const { Worker } = require('worker_threads');

const { buildSetupPlan } = require('../../lib/setup-plan');
const { getProviderDefaults } = require('../../lib/provider-defaults');
const {
  getDefaultProviderId,
  getProviderMetadata,
  listProviderMetadata,
  resolveProviderCommand,
} = require('../../lib/provider-names');
const packageJson = require('../../package.json');

const PROBE_TIMEOUT_MS = 15_000;

function workerProbe(kind, payload = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'setup-scanner-worker.js'), {
      workerData: { kind, payload },
    });
    let settled = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    timer = setTimeout(() => settle({ ok: false, error: 'probe timed out' }), PROBE_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', settle);
    worker.once('error', (error) => settle({ ok: false, error: error.message }));
    worker.once('exit', (code) => {
      if (code !== 0) settle({ ok: false, error: `probe worker exited ${code}` });
    });
  });
}

function commandResult(command, providers, issue) {
  if (command === 'gh') return issue.installed;
  const provider = Object.values(providers).find((item) => item.command === command);
  return provider ? provider.commandAvailable : false;
}

function commandPath(command, providers) {
  const provider = Object.values(providers).find((item) => item.command === command);
  return provider?.path || null;
}

function gitExecResult(command, git) {
  if (command.includes('is-inside-work-tree')) return git.isRepo ? 'true\n' : null;
  if (command.includes('abbrev-ref origin/HEAD')) {
    return git.defaultBranch ? `origin/${git.defaultBranch}\n` : null;
  }
  if (command.includes('abbrev-ref HEAD')) return git.branch ? `${git.branch}\n` : null;
  if (command.includes('remote get-url origin')) return git.remote ? `${git.remote}\n` : null;
  return null;
}

function createPlanDeps({ git, docker, issue, providers }) {
  const providerIds = Object.keys(providers);
  return {
    commandExists: (command) => commandResult(command, providers, issue),
    getCommandPath: (command) => commandPath(command, providers),
    checkDocker: () => ({ available: docker.available }),
    checkGhAuth: () => ({ authenticated: issue.authenticated }),
    execSync: (command) => {
      const result = gitExecResult(command, git);
      if (result === null) throw new Error(`setup scan has no result for: ${command}`);
      return result;
    },
    listProviders: () => providerIds,
    getProvider: (name) => ({
      cliCommand: providers[name].command,
      isAvailable: () => providers[name].available,
    }),
    getProviderDefaults,
    getDefaultProviderId,
    getProviderMetadata,
    getNodeVersion: () => process.version,
    getPackageVersion: () => packageJson.version,
  };
}

function fallbackResult(probe) {
  if (probe.kind === 'git') {
    return { isRepo: false, branch: null, remote: null, defaultBranch: null, clean: null };
  }
  if (probe.kind === 'docker') return { available: false, error: probe.error };
  if (probe.kind === 'issue') {
    return { installed: false, authenticated: false, error: probe.error };
  }
  const metadata = getProviderMetadata(probe.id);
  const { command } = resolveProviderCommand(probe.id);
  return {
    id: probe.id,
    available: false,
    commandAvailable: false,
    command,
    path: null,
    authStatus: 'unknown',
    authReason: probe.error,
    displayName: metadata.displayName,
  };
}

async function trackedProbe(spec, probe, onProgress, startedAt, cwd) {
  let response;
  try {
    response = await probe(spec.kind, { cwd, ...(spec.id ? { id: spec.id } : {}) });
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  const result = response?.ok
    ? response.result
    : fallbackResult({ ...spec, error: response?.error });
  onProgress?.({
    type: 'complete',
    id: spec.id ? `provider:${spec.id}` : spec.kind,
    kind: spec.kind,
    providerId: spec.id || null,
    ok: response?.ok === true,
    elapsedMs: Date.now() - startedAt,
    result,
  });
  return [spec, result];
}
function probeSpecs(metadata) {
  return [
    { kind: 'git' },
    { kind: 'docker' },
    { kind: 'issue' },
    ...metadata.map((provider) => ({ kind: 'provider', id: provider.id })),
  ];
}

function indexProbeResults(entries, metadata) {
  const probes = Object.fromEntries(
    entries.map(([spec, result]) => [spec.id ? `provider:${spec.id}` : spec.kind, result])
  );
  const providers = Object.fromEntries(
    metadata.map((provider) => [provider.id, probes[`provider:${provider.id}`]])
  );
  return { probes, providers };
}

function planFromScan({ cwd, settings, repoSettings, env, probes, providers, deps }) {
  const planDeps = (deps.createPlanDeps || createPlanDeps)({
    git: probes.git,
    docker: probes.docker,
    issue: probes.issue,
    providers,
  });
  return (deps.buildSetupPlan || buildSetupPlan)({
    cwd,
    settings,
    repoSettings,
    env: { ...env, __isTTY: true },
    deps: planDeps,
  });
}

async function scanSetupEnvironment({ cwd, settings, repoSettings, env, onProgress, deps = {} }) {
  const probe = deps.probe || workerProbe;
  const metadata = (deps.listProviderMetadata || listProviderMetadata)();
  const specs = probeSpecs(metadata);
  const startedAt = Date.now();
  if (onProgress) onProgress({ type: 'start', probes: specs, elapsedMs: 0 });
  const entries = await Promise.all(
    specs.map((spec) => trackedProbe(spec, probe, onProgress, startedAt, cwd))
  );
  const { probes, providers } = indexProbeResults(entries, metadata);
  const plan = planFromScan({ cwd, settings, repoSettings, env, probes, providers, deps });
  const elapsedMs = Date.now() - startedAt;
  if (onProgress) onProgress({ type: 'finish', elapsedMs, plan, probes });
  return { plan, probes, elapsedMs };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  createPlanDeps,
  scanSetupEnvironment,
  workerProbe,
};
