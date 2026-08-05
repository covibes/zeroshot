const { buildSetupPlan } = require('../../lib/setup-plan');
const { applyDecisionValues } = require('../../lib/setup-apply');
const { loadSettings, mutateSettings, settingsFileExists } = require('../../lib/settings');
const { readRepoSettings } = require('../../lib/repo-settings');
const {
  beginTerminal,
  createKeyReader,
  line,
  parseKeys,
  selectChoice,
} = require('./setup-wizard-terminal');

function defaultDeps() {
  return {
    buildSetupPlan,
    applyDecisionValues,
    loadSettings,
    mutateSettings,
    settingsFileExists,
    readRepoSettings,
  };
}

function usableProviders(plan) {
  return Object.entries(plan.facts.providers)
    .filter(([, facts]) => facts.available)
    .map(([id, facts]) => ({ id, ...facts }));
}

function buildWizardDecisions(plan, provider, isolation) {
  const decisions = {
    defaultProvider: provider,
    [`providerLevel.${provider}`]: plan.recommended[`providerLevel.${provider}`],
    defaultIsolation: isolation,
    defaultDelivery: 'none',
    defaultIssueSource: plan.recommended.defaultIssueSource,
    updatePolicy: plan.recommended.updatePolicy,
  };
  if (isolation === 'docker') {
    decisions.dockerMounts = plan.recommended.dockerMounts;
    decisions.dockerEnvPassthrough = plan.recommended.dockerEnvPassthrough;
  }
  return decisions;
}

function renderScan(stdout, plan) {
  line(stdout, 'Setup scan');
  line(stdout, `Node: ${plan.facts.node.version}`);
  line(stdout, `Zeroshot: ${plan.facts.node.packageVersion}`);
  line(
    stdout,
    `Git: ${plan.facts.git.isRepo ? `repository (${plan.facts.git.branch || 'detached'})` : 'not a repository'}`
  );
  line(stdout, `Docker: ${plan.facts.docker.available ? 'available' : 'unavailable'}`);
  for (const [id, provider] of Object.entries(plan.facts.providers)) {
    line(
      stdout,
      `${provider.displayName} (${id}): ${provider.available ? provider.path || 'available' : 'unavailable'}`
    );
  }
}

function renderNoProviders(stdout, plan) {
  line(stdout, '\nNo usable provider was detected.');
  for (const provider of Object.values(plan.facts.providers)) {
    line(stdout, `\n${provider.displayName}`);
    for (const instruction of provider.installInstructions.split('\n'))
      line(stdout, `  ${instruction}`);
  }
  line(stdout, '\nRun zeroshot setup after installing a provider.');
}

function isolationChoices(plan) {
  const worktreeUnavailable = plan.facts.git.isRepo ? '' : ' (unavailable: not a git repository)';
  const dockerUnavailable = plan.facts.docker.available ? '' : ' (unavailable)';
  return [
    {
      value: 'worktree',
      label: `Worktree — isolated checkout, current checkout untouched${worktreeUnavailable}`,
      disabled: !plan.facts.git.isRepo,
    },
    {
      value: 'docker',
      label: `Docker — strongest isolation, slower startup${dockerUnavailable}`,
      disabled: !plan.facts.docker.available,
    },
    {
      value: 'none',
      label: 'None — edits the current checkout directly',
      disabled: false,
    },
  ];
}

function renderReview(stdout, plan, provider, isolation) {
  const levels = plan.recommended[`providerLevel.${provider}`];
  line(stdout, '\nReview');
  line(stdout, `Provider: ${plan.facts.providers[provider].displayName}`);
  line(stdout, `Model levels: ${levels.minLevel} → ${levels.defaultLevel} → ${levels.maxLevel}`);
  line(stdout, `Isolation: ${isolation}`);
  line(stdout, 'Delivery: none');
  line(stdout, `Issue source: ${plan.recommended.defaultIssueSource}`);
  line(stdout, `Update policy: ${plan.recommended.updatePolicy}`);
}

function renderComplete(stdout, provider, isolation) {
  line(stdout, '\nSetup complete');
  line(stdout, `Provider: ${provider}`);
  line(stdout, `Isolation: ${isolation}`);
  line(stdout, '\nNext actions:');
  line(stdout, '  zeroshot run <input>');
  line(stdout, `  zeroshot providers setup ${provider}`);
  line(stdout, '  zeroshot --help');
}

async function runSetupWizard({
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  deps = {},
} = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    line(stdout, 'Interactive setup requires a TTY.');
    line(stdout, 'Use `zeroshot setup plan` and `zeroshot setup apply --decisions <file>`.');
    return { status: 'non-interactive', applied: false, exitCode: 1 };
  }

  const resolved = { ...defaultDeps(), ...deps };
  const settings = resolved.loadSettings();
  settings.__meta = { fileExists: resolved.settingsFileExists() };
  const { settings: repoSettings } = resolved.readRepoSettings(cwd);
  const plan = resolved.buildSetupPlan({
    cwd,
    settings,
    repoSettings,
    env: { ...env, __isTTY: true },
    deps: resolved.setupPlanDeps,
  });

  const restoreTerminal = beginTerminal(stdin, stdout);
  const reader = createKeyReader(stdin);
  try {
    renderScan(stdout, plan);
    const providers = usableProviders(plan);
    if (providers.length === 0) {
      renderNoProviders(stdout, plan);
      return { status: 'no-provider', applied: false, exitCode: 1, plan };
    }

    const preferredProvider = providers.findIndex(
      (provider) => provider.id === plan.recommended.defaultProvider
    );
    const provider = await selectChoice({
      stdout,
      reader,
      title: 'Provider',
      choices: providers.map((item) => ({
        value: item.id,
        label: `${item.displayName} — ${item.path}`,
      })),
      initial: preferredProvider < 0 ? 0 : preferredProvider,
    });
    if (!provider) return { status: 'cancelled', applied: false, exitCode: 130 };

    const isolations = isolationChoices(plan);
    const preferredIsolation = isolations.findIndex(
      (choice) => choice.value === plan.recommended.defaultIsolation && !choice.disabled
    );
    const isolation = await selectChoice({
      stdout,
      reader,
      title: 'Isolation',
      choices: isolations,
      initial: preferredIsolation < 0 ? 0 : preferredIsolation,
    });
    if (!isolation) return { status: 'cancelled', applied: false, exitCode: 130 };

    renderReview(stdout, plan, provider, isolation);
    const review = await selectChoice({
      stdout,
      reader,
      title: 'Apply setup?',
      choices: [
        { value: 'apply', label: 'Apply' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (review !== 'apply') return { status: 'cancelled', applied: false, exitCode: 130 };

    const decisions = buildWizardDecisions(plan, provider, isolation);
    const results = resolved.applyDecisionValues({ decisions, cwd });
    resolved.mutateSettings((current) => {
      current.setupVersion = 1;
    });
    renderComplete(stdout, provider, isolation);
    return { status: 'applied', applied: true, exitCode: 0, decisions, results, plan };
  } finally {
    reader.close();
    restoreTerminal();
  }
}

module.exports = {
  runSetupWizard,
  buildWizardDecisions,
  parseKeys,
  selectChoice,
};
