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

import path = require('path');
import type {
  BuildSetupPlanParams,
  DecisionTarget,
  ProposedWrite,
  SetupDecision,
  SetupEnvironment,
  SetupFacts,
  SetupPlan,
  SetupPlanDependencies,
} from './setup-plan-types';

const SCHEMA_VERSION = 2;
type SettingsMap = Record<string, unknown>;
interface ProviderFact {
  available: boolean;
  displayName: string;
  installInstructions: string;
  path: string | null;
}

// Canonical settings keys consumed by resolveEffectiveRunPlan. Never introduce
// a parallel setting or translate a decision into a differently named key.
const DECISION_PATHS: Record<string, DecisionTarget> = {
  defaultProvider: { scope: 'global', path: 'defaultProvider' },
  defaultIsolation: { scope: 'global', path: 'defaultIsolation' },
  allowLocalNoIsolation: { scope: 'global', path: 'allowLocalNoIsolation' },
  defaultDelivery: { scope: 'global', path: 'defaultDelivery' },
  defaultIssueSource: { scope: 'global', path: 'defaultIssueSource' },
  prBase: { scope: 'repo', path: 'prBase' },
  dockerMounts: { scope: 'global', path: 'dockerMounts' },
  dockerEnvPassthrough: { scope: 'global', path: 'dockerEnvPassthrough' },
  updatePolicy: { scope: 'global', path: 'updatePolicy' },
};

function providerLevelDecisionId(providerName: string): string {
  return `providerLevel.${providerName}`;
}

// Settings keys consumed by runtime resolvers. Shared by buildProposedWrites
// and setup apply so neither surface can advertise dead configuration.
const CONSUMED_PATHS = new Set<string>([
  'global:defaultProvider',
  'global:defaultIsolation',
  'global:defaultDelivery',
  'global:defaultIssueSource',
  'global:dockerMounts',
  'global:dockerEnvPassthrough',
  // No resolver consumes this yet; consumption is deferred to a future
  // update-policy issue, but issue #606 explicitly sanctions writing it now.
  'global:updatePolicy',
]);

function isConsumedPath(scope: string, targetPath: string): boolean {
  if (scope === 'global' && targetPath.startsWith('providerSettings.')) return true;
  return CONSUMED_PATHS.has(`${scope}:${targetPath}`);
}

// providerLevel.<provider> decisionIds map to a per-provider settings key
// (providerSettings.<provider>) not present in DECISION_PATHS above, since
// the provider name is only known at runtime.
function resolveDecisionPath(decisionId: string): DecisionTarget | null {
  if (decisionId.startsWith('providerLevel.')) {
    const providerName = decisionId.slice('providerLevel.'.length);
    return { scope: 'global', path: `providerSettings.${providerName}` };
  }
  return DECISION_PATHS[decisionId] || null;
}

function getNestedValue(source: unknown, pathStr: string): unknown {
  return pathStr
    .split('.')
    .reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      // Property access intentionally retains JavaScript's primitive boxing behavior.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return (acc as SettingsMap)[key];
    }, source);
}

function defaultDeps(): SetupPlanDependencies {
  // These paths intentionally resolve beside the emitted module in lib/.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { commandExists, getCommandPath }: Pick<
    SetupPlanDependencies,
    'commandExists' | 'getCommandPath'
  > = require('./provider-detection');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { checkDocker, checkGhAuth }: Pick<
    SetupPlanDependencies,
    'checkDocker' | 'checkGhAuth'
  > = require('../src/preflight');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { execSync }: Pick<SetupPlanDependencies, 'execSync'> = require('../src/lib/safe-exec');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { listProviders, getProvider }: Pick<
    SetupPlanDependencies,
    'listProviders' | 'getProvider'
  > = require('../src/providers');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { getProviderDefaults }: Pick<SetupPlanDependencies, 'getProviderDefaults'> =
    require('./provider-defaults');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { getDefaultProviderId, getProviderMetadata }: Pick<
    SetupPlanDependencies,
    'getDefaultProviderId' | 'getProviderMetadata'
  > = require('./provider-names');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const packageJson: { version: string } = require('../package.json');

  return {
    commandExists,
    getCommandPath,
    checkDocker,
    checkGhAuth,
    execSync,
    listProviders,
    getProvider,
    getProviderDefaults,
    getDefaultProviderId,
    getProviderMetadata,
    getNodeVersion: () => process.version,
    getPackageVersion: () => packageJson.version,
  };
}

function detectInstallSource(cwd: string, env: SetupEnvironment): string {
  if (env.npm_config_global === 'true') return 'npm-global';
  if (env.npm_execpath && /_npx|npx/.test(env.npm_execpath)) return 'npx';
  const ownNodeModules = path.join(__dirname, '..', 'node_modules');
  if (cwd && (cwd === path.join(__dirname, '..') || cwd.startsWith(ownNodeModules))) return 'local';
  return 'unknown';
}

function buildNodeFacts({
  cwd,
  env,
  deps,
}: {
  cwd: string;
  deps: SetupPlanDependencies;
  env: SetupEnvironment;
}): SetupFacts['node'] {
  return {
    version: deps.getNodeVersion(),
    packageVersion: deps.getPackageVersion(),
    installSource: detectInstallSource(cwd, env),
  };
}

function buildProviderFacts(deps: SetupPlanDependencies): Record<string, ProviderFact> {
  const providers: Record<string, ProviderFact> = {};
  for (const name of deps.listProviders()) {
    const metadata = deps.getProviderMetadata(name);
    const provider = deps.getProvider(name);
    let available = false;
    try {
      available = provider.isAvailable() === true;
    } catch {
      available = false;
    }
    const cliCommand = provider.cliCommand || metadata.binary;
    providers[name] = {
      available,
      displayName: metadata.displayName,
      installInstructions: metadata.installInstructions,
      path: available && deps.commandExists(cliCommand) ? deps.getCommandPath(cliCommand) : null,
    };
  }
  return providers;
}

function safeExecTrim(
  deps: SetupPlanDependencies,
  command: string,
  cwd: string
): string | null {
  try {
    return deps.execSync(command, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function buildGitFacts({
  cwd,
  deps,
}: {
  cwd: string;
  deps: SetupPlanDependencies;
}): SetupFacts['git'] {
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

function buildFacts({
  cwd,
  settings,
  repoSettings,
  env,
  deps,
}: {
  cwd: string;
  deps: SetupPlanDependencies;
  env: SetupEnvironment;
  repoSettings: SettingsMap | null | undefined;
  settings: SettingsMap;
}): SetupFacts {
  return {
    node: buildNodeFacts({ cwd, env, deps }),
    providers: buildProviderFacts(deps),
    git: buildGitFacts({ cwd, deps }),
    docker: { available: !!deps.checkDocker().available },
    settings: {
      hasGlobal: settings.__meta ? Boolean(getNestedValue(settings.__meta, 'fileExists')) : true,
      hasRepo: repoSettings !== null && repoSettings !== undefined,
    },
  };
}

function inferIssueSource(facts: SetupFacts): string | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { parseGitRemoteUrl }: {
    parseGitRemoteUrl(remote: string | null): { provider?: string } | null;
  } = require('./git-remote-utils');
  const parsed = parseGitRemoteUrl(facts.git.remote);
  return parsed?.provider || null;
}

function inferPrBase(cwd: string, deps: SetupPlanDependencies): string | null {
  const branch = safeExecTrim(deps, 'git rev-parse --abbrev-ref origin/HEAD', cwd);
  if (!branch) return null;
  return branch.replace(/^origin\//, '');
}

function buildProviderLevelRecommendation(
  name: string,
  deps: SetupPlanDependencies
): Record<string, unknown> {
  const providerDefaults = deps.getProviderDefaults()[name] || {};
  return {
    minLevel: providerDefaults.minLevel || 'level1',
    defaultLevel: providerDefaults.defaultLevel || 'level2',
    maxLevel: providerDefaults.maxLevel || 'level3',
  };
}

function buildRecommendedAndRisk({
  cwd,
  facts,
  env,
  deps,
}: {
  cwd: string;
  deps: SetupPlanDependencies;
  env: SetupEnvironment;
  facts: SetupFacts;
}): {
  inferredIssueSource: string | null;
  inferredPrBase: string | null;
  recommended: Record<string, unknown>;
  risk: Record<string, string>;
} {
  const recommended: Record<string, unknown> = {};
  const risk: Record<string, string> = {};
  const registryDefault = deps.getDefaultProviderId();
  recommended.defaultProvider = registryDefault;
  risk.defaultProvider = facts.providers[registryDefault]?.available ? 'low' : 'medium';

  for (const name of Object.keys(facts.providers)) {
    recommended[providerLevelDecisionId(name)] = buildProviderLevelRecommendation(name, deps);
    risk[providerLevelDecisionId(name)] = 'low';
  }

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

function currentValueFor(
  decisionId: string,
  settings: SettingsMap,
  repoSettings: SettingsMap | null | undefined
): unknown {
  const target = resolveDecisionPath(decisionId);
  if (!target) return null;
  const source = target.scope === 'repo' ? repoSettings || {} : settings || {};
  const value = getNestedValue(source, target.path);
  return value === undefined ? null : value;
}

function buildDecisions({
  facts,
  settings,
  repoSettings,
  inferredIssueSource,
  inferredPrBase,
}: {
  facts: SetupFacts;
  inferredIssueSource: string | null;
  inferredPrBase: string | null;
  repoSettings: SettingsMap | null | undefined;
  settings: SettingsMap;
}): SetupDecision[] {
  const decisions: SetupDecision[] = [];
  const hasGlobal = facts.settings.hasGlobal;
  const hasRepo = facts.settings.hasRepo;

  const globalDecisionIds = [
    'defaultProvider',
    ...Object.keys(facts.providers).map(providerLevelDecisionId),
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

function domainFor(decisionId: string): string {
  if (decisionId.startsWith('providerLevel.')) {
    return '{ minLevel, defaultLevel, maxLevel } of level1|level2|level3';
  }
  const domains: Record<string, string> = {
    defaultProvider: 'registry provider id',
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

function buildProposedWrites({
  decisions,
  recommended,
}: {
  decisions: SetupDecision[];
  recommended: Record<string, unknown>;
}): ProposedWrite[] {
  const writes: ProposedWrite[] = [];
  for (const decision of decisions) {
    const target = resolveDecisionPath(decision.decisionId);
    if (!target) continue;
    // A decision can still be surfaced for the user to make (e.g. a future
    // wizard asking about prBase), but proposing a *write* for a settings key
    // no resolver reads would advertise a write that apply will always skip —
    // dead config. Only propose writes apply will actually perform.
    if (!isConsumedPath(target.scope, target.path)) continue;
    const to = recommended[decision.decisionId];
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
 */
function buildSetupPlan({
  cwd,
  settings,
  repoSettings,
  env,
  deps,
}: BuildSetupPlanParams = {}): SetupPlan {
  const resolvedDeps: SetupPlanDependencies = { ...defaultDeps(), ...(deps || {}) };
  const resolvedEnv: SetupEnvironment = env || {};
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

export = {
  buildSetupPlan,
  resolveDecisionPath,
  domainFor,
  DECISION_PATHS,
  getNestedValue,
  isConsumedPath,
  CONSUMED_PATHS,
};
