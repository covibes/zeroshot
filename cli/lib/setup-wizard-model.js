const { isDeepStrictEqual } = require('util');

const { getNestedValue, resolveDecisionPath } = require('../../lib/setup-plan');

function enabled(enabledGroups, id) {
  return enabledGroups?.[id] !== false;
}

function buildWizardDecisions(plan, provider, isolation, enabledGroups = {}) {
  const decisions = {
    defaultProvider: provider,
    [`providerLevel.${provider}`]: plan.recommended[`providerLevel.${provider}`],
    defaultIsolation: isolation,
    defaultDelivery: 'none',
  };
  if (enabled(enabledGroups, 'issue-source')) {
    decisions.defaultIssueSource = plan.recommended.defaultIssueSource;
  }
  if (enabled(enabledGroups, 'updates')) decisions.updatePolicy = plan.recommended.updatePolicy;
  if (isolation === 'docker' && enabled(enabledGroups, 'docker')) {
    decisions.dockerMounts = plan.recommended.dockerMounts;
    decisions.dockerEnvPassthrough = plan.recommended.dockerEnvPassthrough;
  }
  return decisions;
}

function previewValue(decisionId, value, settings) {
  if (!decisionId.startsWith('providerLevel.')) return value;
  const provider = decisionId.slice('providerLevel.'.length);
  return { ...(settings.providerSettings?.[provider] || {}), ...value };
}

function decisionPreview(decisionId, value, settings, settingsFile) {
  const target = resolveDecisionPath(decisionId);
  if (!target) throw new Error(`Unknown setup decision: ${decisionId}`);
  const source = target.scope === 'global' ? settings : {};
  const from = getNestedValue(source, target.path) ?? null;
  const to = previewValue(decisionId, value, settings);
  if (isDeepStrictEqual(from, to)) return null;
  return {
    decisionId,
    scope: target.scope,
    path: target.path,
    from,
    to,
    targetFile: target.scope === 'global' ? settingsFile : '.zeroshot/settings.json',
  };
}

function groupDefinition(id, title, required, decisionIds) {
  return { id, title, required, decisionIds };
}

function wizardDecisionGroups(provider, isolation) {
  const groups = [
    groupDefinition('execution', 'Execution defaults', true, [
      'defaultProvider',
      `providerLevel.${provider}`,
      'defaultIsolation',
      'defaultDelivery',
    ]),
    groupDefinition('issue-source', 'Repository integration', false, ['defaultIssueSource']),
    groupDefinition('updates', 'Update notifications', false, ['updatePolicy']),
  ];
  if (isolation === 'docker') {
    groups.splice(
      1,
      0,
      groupDefinition('docker', 'Docker defaults', true, ['dockerMounts', 'dockerEnvPassthrough'])
    );
  }
  return groups;
}

function buildWizardPlanModel({
  plan,
  settings,
  settingsFile,
  provider,
  isolation,
  enabledGroups,
}) {
  const decisions = buildWizardDecisions(plan, provider, isolation, enabledGroups);
  const previewById = new Map();
  for (const [decisionId, value] of Object.entries(decisions)) {
    const preview = decisionPreview(decisionId, value, settings, settingsFile);
    if (preview) previewById.set(decisionId, preview);
  }
  const groups = wizardDecisionGroups(provider, isolation).map((group) => ({
    ...group,
    enabled: group.required || enabled(enabledGroups, group.id),
    writes: group.decisionIds.map((id) => previewById.get(id)).filter(Boolean),
  }));
  const writes = groups.flatMap((group) => (group.enabled ? group.writes : []));
  return {
    decisions,
    groups,
    writes,
    files: [...new Set(writes.map((write) => write.targetFile))],
  };
}

function isolationChoices(plan) {
  return [
    {
      value: 'worktree',
      label: 'Worktree',
      detail: plan.facts.git.isRepo
        ? 'isolated checkout · current checkout untouched'
        : 'unavailable · not a git repository',
      disabled: !plan.facts.git.isRepo,
    },
    {
      value: 'docker',
      label: 'Docker',
      detail: plan.facts.docker.available
        ? 'strongest isolation · slower startup'
        : 'unavailable · Docker is not running',
      disabled: !plan.facts.docker.available,
    },
    {
      value: 'none',
      label: 'Current checkout',
      detail: 'no isolation · edits the active checkout directly',
      disabled: false,
    },
  ];
}

function preferredIndex(choices, preferredValue) {
  const preferred = choices.findIndex(
    (choice) => choice.value === preferredValue && !choice.disabled
  );
  if (preferred >= 0) return preferred;
  return choices.findIndex((choice) => !choice.disabled);
}

function syntheticScan(plan, onProgress) {
  const providerSpecs = Object.keys(plan.facts.providers).map((id) => ({ kind: 'provider', id }));
  const specs = [{ kind: 'git' }, { kind: 'docker' }, { kind: 'issue' }, ...providerSpecs];
  const probes = {
    git: { ...plan.facts.git, clean: true, defaultBranch: plan.facts.git.branch },
    docker: { ...plan.facts.docker },
    issue: {
      installed: plan.facts.git.ghAvailable === true,
      authenticated: plan.facts.git.ghAuthed === true,
      error: null,
    },
  };
  for (const [id, facts] of Object.entries(plan.facts.providers)) {
    probes[`provider:${id}`] = {
      id,
      available: facts.available,
      commandAvailable: facts.available,
      displayName: facts.displayName,
      path: facts.path,
      authStatus: facts.available ? 'ready' : 'unknown',
      authReason: null,
    };
  }
  onProgress?.({ type: 'start', probes: specs, elapsedMs: 0 });
  for (const spec of specs) {
    const id = spec.id ? `provider:${spec.id}` : spec.kind;
    onProgress?.({
      type: 'complete',
      id,
      kind: spec.kind,
      providerId: spec.id || null,
      ok: true,
      elapsedMs: 0,
      result: probes[id],
    });
  }
  onProgress?.({ type: 'finish', elapsedMs: 0, plan, probes });
  return { plan, probes, elapsedMs: 0 };
}

function collectSetupScan({ cwd, settings, repoSettings, env, resolved, deps, onProgress }) {
  if (deps.buildSetupPlan && !deps.scanSetupEnvironment) {
    const plan = resolved.buildSetupPlan({
      cwd,
      settings,
      repoSettings,
      env: { ...env, __isTTY: true },
      deps: resolved.setupPlanDeps,
    });
    return syntheticScan(plan, onProgress);
  }
  return resolved.scanSetupEnvironment({
    cwd,
    settings,
    repoSettings,
    env,
    onProgress,
    deps: resolved.setupScanDeps,
  });
}

module.exports = {
  buildWizardDecisions,
  buildWizardPlanModel,
  collectSetupScan,
  isolationChoices,
  preferredIndex,
};
