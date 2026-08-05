const { isDeepStrictEqual } = require('util');

const { applyDecisionValues } = require('../../lib/setup-apply');
const { buildSetupPlan, getNestedValue, resolveDecisionPath } = require('../../lib/setup-plan');
const {
  getSettingsFile,
  loadSettings,
  mutateSettings,
  settingsFileExists,
} = require('../../lib/settings');
const { readRepoSettings } = require('../../lib/repo-settings');
const { runPreflight } = require('../../src/preflight');
const { providerChoices } = require('./setup-provider-readiness');
const { scanSetupEnvironment } = require('./setup-scanner');
const {
  buildWizardDecisions,
  buildWizardPlanModel,
  collectSetupScan,
  isolationChoices,
  preferredIndex,
} = require('./setup-wizard-model');
const {
  beginTerminal,
  createKeyReader,
  line,
  parseKeys,
  selectChoice,
  stripAnsi,
} = require('./setup-wizard-terminal');
const { WizardRenderer } = require('./setup-wizard-view');

function defaultDeps() {
  return {
    applyDecisionValues,
    buildSetupPlan,
    getSettingsFile,
    loadSettings,
    mutateSettings,
    readRepoSettings,
    runPreflight,
    scanSetupEnvironment,
    settingsFileExists,
  };
}

function verifyPersistedDecisions(decisions, persisted) {
  for (const [decisionId, expected] of Object.entries(decisions)) {
    const target = resolveDecisionPath(decisionId);
    if (!target || target.scope !== 'global') continue;
    const actual = getNestedValue(persisted, target.path);
    if (decisionId.startsWith('providerLevel.')) {
      for (const [key, value] of Object.entries(expected)) {
        if (actual?.[key] !== value) {
          throw new Error(`Persisted ${target.path}.${key} did not match the approved plan`);
        }
      }
    } else if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`Persisted ${target.path} did not match the approved plan`);
    }
  }
}

function preflightFailure(result) {
  const message = result.errors
    .map((error) => stripAnsi(error).trim())
    .filter(Boolean)
    .join('\n');
  return new Error(message || 'Setup preflight failed');
}

async function verifyAppliedSetup({ resolved, decisions, provider, isolation, cwd }) {
  const persisted = resolved.loadSettings();
  verifyPersistedDecisions(decisions, persisted);
  const preflight = await resolved.runPreflight({
    cwd,
    settings: persisted,
    provider,
    requireDocker: isolation === 'docker',
    requireGit: isolation === 'worktree',
    quiet: true,
  });
  if (!preflight.valid) throw preflightFailure(preflight);
  return { persisted, preflight };
}

function renderBlockedProviders(renderer, choices) {
  const theme = renderer.theme;
  line(renderer.stdout, theme.danger('No provider is ready for the selected isolation.'));
  for (const choice of choices) {
    line(
      renderer.stdout,
      `  ${choice.label}: ${choice.status}${choice.detail ? ` · ${choice.detail}` : ''}`
    );
    const action =
      choice.status === 'unavailable' ? choice.installInstructions : choice.authInstructions;
    if (action) line(renderer.stdout, `    ${action.split('\n')[0]}`);
  }
  line(renderer.stdout, 'Run `zeroshot setup` again after resolving one provider.');
}

function cancelledResult(renderer, plan) {
  renderer.cancelled();
  return { status: 'cancelled', applied: false, exitCode: 130, plan };
}

function hasAvailableProvider(probes) {
  return Object.entries(probes).some(
    ([id, probe]) => id.startsWith('provider:') && probe.available
  );
}

function blockedProviderResult(renderer, request) {
  renderBlockedProviders(renderer, providerChoices(request));
  return { status: 'no-provider', applied: false, exitCode: 1, plan: request.plan };
}

async function chooseWizardConfiguration({ renderer, reader, plan, probes, settings }) {
  const isolations = isolationChoices(plan);
  if (!hasAvailableProvider(probes)) {
    const preview = isolations.find((choice) => !choice.disabled)?.value || 'none';
    return {
      result: blockedProviderResult(renderer, { plan, probes, isolation: preview, settings }),
    };
  }
  const isolation = await renderer.choose({
    title: 'Isolation',
    meta: 'execution context',
    choices: isolations,
    initial: preferredIndex(isolations, plan.recommended.defaultIsolation),
    reader,
  });
  if (!isolation) return { result: cancelledResult(renderer, plan) };
  const providers = providerChoices({ plan, probes, isolation, settings });
  if (!providers.some((choice) => !choice.disabled)) {
    return {
      result: blockedProviderResult(renderer, { plan, probes, isolation, settings }),
    };
  }
  const provider = await renderer.choose({
    title: 'Provider',
    meta: `${isolation}-compatible`,
    choices: providers,
    initial: preferredIndex(providers, plan.recommended.defaultProvider),
    reader,
    provider: true,
  });
  return provider ? { provider, isolation } : { result: cancelledResult(renderer, plan) };
}

async function applyApprovedPlan({
  renderer,
  resolved,
  plan,
  provider,
  isolation,
  enabledGroups,
  cwd,
}) {
  renderer.applyStarted();
  const decisions = buildWizardDecisions(plan, provider, isolation, enabledGroups);
  let receipts = [];
  try {
    receipts = resolved.applyDecisionValues({ decisions, cwd });
    renderer.applyReceipts(receipts);
    const verification = await verifyAppliedSetup({
      resolved,
      decisions,
      provider,
      isolation,
      cwd,
    });
    resolved.mutateSettings((current) => {
      current.setupVersion = 1;
    });
    renderer.applyVerified(receipts);
    renderer.ready(provider, isolation);
    return {
      status: 'applied',
      applied: true,
      exitCode: 0,
      decisions,
      results: receipts,
      verification,
      plan,
    };
  } catch (error) {
    renderer.failed('Setup was not completed.', error, receipts);
    return {
      status: 'failed',
      applied: receipts.some((receipt) => receipt.applied),
      exitCode: 1,
      error,
    };
  }
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
  const restoreTerminal = beginTerminal(stdin, stdout);
  const reader = createKeyReader(stdin, stdout);
  const renderer = new WizardRenderer({
    stdout,
    env,
    clock: resolved.clock,
    motion: resolved.motion,
  });
  try {
    renderer.intro();
    const scanPresenter = renderer.scanPresenter();
    const scan = await collectSetupScan({
      cwd,
      settings,
      repoSettings,
      env,
      resolved,
      deps,
      onProgress: (event) => scanPresenter.handle(event),
    });
    scanPresenter.commit(scan);
    const selection = await chooseWizardConfiguration({
      renderer,
      reader,
      plan: scan.plan,
      probes: scan.probes,
      settings,
    });
    if (selection.result) return selection.result;
    const settingsFile = resolved.getSettingsFile();
    const buildModel = (enabledGroups) =>
      buildWizardPlanModel({
        plan: scan.plan,
        settings,
        settingsFile,
        provider: selection.provider,
        isolation: selection.isolation,
        enabledGroups,
      });
    const approval = await renderer.plan(reader, buildModel);
    if (approval.action !== 'apply') return cancelledResult(renderer, scan.plan);
    return applyApprovedPlan({
      renderer,
      resolved,
      plan: scan.plan,
      provider: selection.provider,
      isolation: selection.isolation,
      enabledGroups: approval.enabled,
      cwd,
    });
  } catch (error) {
    renderer.fatal('Setup scan failed.', error);
    return { status: 'failed', applied: false, exitCode: 1, error };
  } finally {
    reader.close();
    restoreTerminal();
  }
}

module.exports = {
  runSetupWizard,
  buildWizardDecisions,
  buildWizardPlanModel,
  isolationChoices,
  parseKeys,
  preferredIndex,
  selectChoice,
  verifyPersistedDecisions,
};
