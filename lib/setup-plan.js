/**
 * Setup plan — read-only facts collector + the pinned, versioned setup contract.
 *
 * buildSetupPlan() is pure over its injected inputs: no direct process.env/fs
 * reads for config data, no writes, no prompts. Everything downstream (apply,
 * undo, the TTY wizard, agents) consumes the object this returns, so its shape
 * (schemaVersion, facts, decisions, recommended, risk, proposedWrites) and the
 * decisionId registry below are a stable contract — do not rename IDs or add a
 * parallel run-mode field without updating every consumer.
 */

const path = require('path');

const SCHEMA_VERSION = 2;

// Canonical settings key each decision maps to. `defaultIsolation` and
// `defaultDelivery` MUST stay pinned to the keys resolveEffectiveRunPlan
// already reads (today: settings.defaultDocker) — see the canonical-path
// rule in issue #605. Never introduce a second parallel key here.
const DECISION_PATHS = {
  defaultIsolation: { scope: 'global', path: 'defaultDocker' },
  allowLocalNoIsolation: { scope: 'global', path: 'allowLocalNoIsolation' },
  defaultDelivery: { scope: 'global', path: 'defaultDelivery' },
  defaultIssueSource: { scope: 'global', path: 'defaultIssueSource' },
  prBase: { scope: 'repo', path: 'prBase' },
  dockerMounts: { scope: 'global', path: 'dockerMounts' },
  dockerEnvPassthrough: { scope: 'global', path: 'dockerEnvPassthrough' },
  updatePolicy: { scope: 'global', path: 'updatePolicy' },
};

// Settings keys a run-mode resolver actually reads today. Shared by
// buildProposedWrites below (never propose a write nobody will read) and by
// lib/setup-apply.js (never perform a write nobody will read) — one
// canonical answer to "is this key consumed?" so the two can't drift.
const CONSUMED_PATHS = new Set([
  'global:defaultDocker',
  'global:defaultDelivery',
  'global:defaultIssueSource',
  'global:dockerMounts',
  'global:dockerEnvPassthrough',
  // No resolver consumes this yet; consumption is deferred to a future
  // update-policy issue, but issue #606 explicitly sanctions writing it now.
  'global:updatePolicy',
]);

function isConsumedPath(scope, targetPath) {
  return CONSUMED_PATHS.has(`${scope}:${targetPath}`);
}

function resolveDecisionPath(decisionId) {
  return DECISION_PATHS[decisionId] || null;
}

function getNestedValue(source, pathStr) {
  return pathStr
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), source);
}

function defaultDeps() {
  const { commandExists, getCommandPath } = require('./provider-detection');
  const { getProviderMetadata } = require('./provider-names');
  const { checkDocker, checkGhAuth } = require('../src/preflight');
  const { execSync } = require('../src/lib/safe-exec');
  const { listProviders, getProvider } = require('../src/providers');

  const packageJson = require('../package.json');
  const { resolveOmpSdkRuntime } = require('../scripts/omp-sdk-runtime');

  return {
    commandExists,
    getCommandPath,
    checkDocker,
    checkGhAuth,
    execSync,
    listProviders,
    getProvider,
    getProviderMetadata,
    resolveOmpSdkRuntime,
    getNodeVersion: () => process.version,
    getPackageVersion: () => packageJson.version,
  };
}

function detectInstallSource(cwd, env) {
  if (env.npm_config_global === 'true') return 'npm-global';
  if (env.npm_execpath && /_npx|npx/.test(env.npm_execpath)) return 'npx';
  try {
    const ownNodeModules = path.join(__dirname, '..', 'node_modules');
    if (cwd && (cwd === path.join(__dirname, '..') || cwd.startsWith(ownNodeModules))) {
      return 'local';
    }
  } catch {
    // fall through to unknown
  }
  return 'unknown';
}

function buildNodeFacts({ cwd, env, deps }) {
  return {
    version: deps.getNodeVersion(),
    packageVersion: deps.getPackageVersion(),
    installSource: detectInstallSource(cwd, env),
  };
}

function buildProviderFacts(settings, deps) {
  const providers = {};
  for (const name of deps.listProviders()) {
    let provider;
    let metadata;
    let cliCommand = name;
    try {
      provider = deps.getProvider(name);
      metadata = deps.getProviderMetadata(name);
      cliCommand = provider.cliCommand || name;
    } catch {
      // Provider metadata unavailable — retain a closed unavailable fact.
    }

    const configuredSettings = {
      ...(metadata?.settingsDefaults || {}),
      ...(settings?.providerSettings?.[name] || {}),
    };
    const source = configuredSettings.transport === 'sdk' ? 'bundled-sdk' : 'cli';
    let available;
    let runtime = null;
    if (source === 'bundled-sdk') {
      try {
        const resolved = deps.resolveOmpSdkRuntime();
        available = true;
        runtime = {
          backend: 'omp-sdk',
          backendVersion: resolved.ompVersion,
          name: 'bun',
          version: resolved.bunVersion,
        };
      } catch {
        available = false;
      }
    } else {
      available = deps.commandExists(cliCommand);
    }

    const configurationError =
      typeof metadata?.settingsValidator === 'function'
        ? metadata.settingsValidator(configuredSettings, {
            executionContext: settings?.defaultDocker === true ? 'docker' : 'host',
            requireModelConfiguration: true,
          })
        : null;
    providers[name] = {
      available,
      runnable: available === true && configurationError === null,
      configurationError,
      source,
      runtime,
      // Retained for schema-v1 consumers. A bundled SDK is deliberately not
      // described as a globally installed CLI.
      cliAvailable: source === 'cli' && available,
      path: available && source === 'cli' ? deps.getCommandPath(cliCommand) : null,
    };
  }
  return providers;
}

function safeExecTrim(deps, command, cwd) {
  try {
    return deps.execSync(command, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function buildGitFacts({ cwd, deps }) {
  const isRepo = safeExecTrim(deps, 'git rev-parse --is-inside-work-tree', cwd) === 'true';
  const ghAvailable = deps.commandExists('gh');

  if (!isRepo) {
    return { isRepo: false, branch: null, remote: null, ghAvailable, ghAuthed: null };
  }

  const branch = safeExecTrim(deps, 'git rev-parse --abbrev-ref HEAD', cwd);
  const remote = safeExecTrim(deps, 'git remote get-url origin', cwd);
  const ghAuthed = ghAvailable ? !!deps.checkGhAuth().authenticated : null;

  return { isRepo: true, branch, remote, ghAvailable, ghAuthed };
}

function buildFacts({ cwd, settings, repoSettings, env, deps }) {
  return {
    node: buildNodeFacts({ cwd, env, deps }),
    providers: buildProviderFacts(settings, deps),
    git: buildGitFacts({ cwd, deps }),
    docker: { available: !!deps.checkDocker().available },
    settings: {
      hasGlobal: settings?.__meta ? !!settings.__meta.fileExists : true,
      hasRepo: repoSettings !== null && repoSettings !== undefined,
    },
  };
}

function inferIssueSource(facts) {
  const { parseGitRemoteUrl } = require('./git-remote-utils');
  const parsed = parseGitRemoteUrl(facts.git.remote);
  return parsed?.provider || null;
}

function inferPrBase(cwd, deps) {
  const branch = safeExecTrim(deps, 'git rev-parse --abbrev-ref origin/HEAD', cwd);
  if (!branch) return null;
  return branch.replace(/^origin\//, '');
}

function buildRecommendedAndRisk({ cwd, facts, env, deps }) {
  const recommended = {};
  const risk = {};


  if (facts.git.isRepo) {
    recommended.defaultIsolation = 'worktree';
    risk.defaultIsolation = 'low';
  } else if (facts.docker.available) {
    recommended.defaultIsolation = 'docker';
    risk.defaultIsolation = 'low';
  } else {
    recommended.defaultIsolation = 'none';
    risk.defaultIsolation = 'high';
  }

  recommended.allowLocalNoIsolation = false;
  risk.allowLocalNoIsolation = 'low';

  recommended.defaultDelivery = 'none';
  risk.defaultDelivery = 'low';

  const inferredIssueSource = inferIssueSource(facts);
  recommended.defaultIssueSource = inferredIssueSource || 'github';
  risk.defaultIssueSource = inferredIssueSource ? 'low' : 'medium';

  const inferredPrBase = inferPrBase(cwd, deps);
  recommended.prBase = inferredPrBase || 'main';
  risk.prBase = inferredPrBase ? 'low' : 'medium';

  recommended.dockerMounts = ['gh', 'git', 'ssh'];
  risk.dockerMounts = 'low';

  recommended.dockerEnvPassthrough = [];
  risk.dockerEnvPassthrough = 'low';

  const nonInteractive = env.CI === 'true' || env.__isTTY === false;
  recommended.updatePolicy = nonInteractive ? 'off' : 'notify';
  risk.updatePolicy = 'low';

  return { recommended, risk, inferredIssueSource, inferredPrBase };
}

function currentValueFor(decisionId, settings, repoSettings) {
  const target = resolveDecisionPath(decisionId);
  if (!target) return null;
  const source = target.scope === 'repo' ? repoSettings || {} : settings || {};
  const value = getNestedValue(source, target.path);
  return value === undefined ? null : value;
}

function buildDecisions({ facts, settings, repoSettings, inferredIssueSource, inferredPrBase }) {
  const decisions = [];
  const hasGlobal = facts.settings.hasGlobal;
  const hasRepo = facts.settings.hasRepo;

  const globalDecisionIds = [
    'defaultIsolation',
    'allowLocalNoIsolation',
    'defaultDelivery',
    'defaultIssueSource',
    'dockerMounts',
    'dockerEnvPassthrough',
    'updatePolicy',
  ];

  for (const decisionId of globalDecisionIds) {
    const shouldInclude =
      !hasGlobal || (decisionId === 'defaultIssueSource' && !inferredIssueSource);
    if (!shouldInclude) continue;
    decisions.push({
      decisionId,
      domain: domainFor(decisionId),
      currentValue: currentValueFor(decisionId, settings, repoSettings),
    });
  }

  if (!hasRepo || !inferredPrBase) {
    decisions.push({
      decisionId: 'prBase',
      domain: domainFor('prBase'),
      currentValue: currentValueFor('prBase', settings, repoSettings),
    });
  }

  return decisions;
}

function domainFor(decisionId) {
  const domains = {
    defaultIsolation: 'worktree | docker | none',
    allowLocalNoIsolation: 'boolean',
    defaultDelivery: 'none | pr | ship',
    defaultIssueSource: 'github | gitlab | jira | azure-devops | linear',
    prBase: 'string (branch)',
    dockerMounts: 'array of presets/objects',
    dockerEnvPassthrough: 'string[]',
    updatePolicy: 'off | notify | auto',
  };
  return domains[decisionId] || 'unknown';
}

function buildProposedWrites({ decisions, recommended }) {
  const writes = [];
  for (const decision of decisions) {
    const target = resolveDecisionPath(decision.decisionId);
    if (!target) continue;
    // A decision can still be surfaced for the user to make (e.g. a future
    // wizard asking about prBase), but proposing a *write* for a settings key
    // no resolver reads would advertise a write that apply will always skip —
    // dead config. Only propose writes apply will actually perform.
    if (!isConsumedPath(target.scope, target.path)) continue;
    let to = recommended[decision.decisionId];
    if (to === null || to === undefined) continue;
    if (decision.decisionId === 'defaultIsolation') {
      to = to === 'docker';
    }
    if (to === decision.currentValue) continue;
    writes.push({
      scope: target.scope,
      path: target.path,
      from: decision.currentValue ?? null,
      to,
      decisionId: decision.decisionId,
    });
  }
  return writes;
}

/**
 * Build the pinned, versioned setup contract. Pure over injected inputs —
 * performs only cheap, read-only detection (no writes, no prompts).
 *
 * @param {Object} params
 * @param {string} params.cwd
 * @param {Object} params.settings - loaded global settings (optionally with __meta.fileExists)
 * @param {Object|null} params.repoSettings - repo-local settings object, or null
 * @param {Object} params.env - caller-provided env (e.g. process.env), plus optional __isTTY
 * @param {Object} [params.deps] - injected dependencies (for testing)
 * @returns {Object} plan
 */
function buildSetupPlan({ cwd, settings, repoSettings, env, deps } = {}) {
  const resolvedDeps = { ...defaultDeps(), ...(deps || {}) };
  const resolvedEnv = env || {};
  const resolvedCwd = cwd || '.';
  const resolvedSettings = settings || {};

  const facts = buildFacts({
    cwd: resolvedCwd,
    settings: resolvedSettings,
    repoSettings,
    env: resolvedEnv,
    deps: resolvedDeps,
  });

  const { recommended, risk, inferredIssueSource, inferredPrBase } = buildRecommendedAndRisk({
    cwd: resolvedCwd,
    facts,
    env: resolvedEnv,
    deps: resolvedDeps,
  });

  const decisions = buildDecisions({
    facts,
    settings: resolvedSettings,
    repoSettings,
    inferredIssueSource,
    inferredPrBase,
  });

  const proposedWrites = buildProposedWrites({ decisions, recommended });

  return {
    schemaVersion: SCHEMA_VERSION,
    facts,
    decisions,
    recommended,
    risk,
    proposedWrites,
  };
}

module.exports = {
  buildSetupPlan,
  resolveDecisionPath,
  domainFor,
  DECISION_PATHS,
  getNestedValue,
  isConsumedPath,
  CONSUMED_PATHS,
};
