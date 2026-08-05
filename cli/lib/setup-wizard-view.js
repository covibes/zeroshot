const {
  LiveRegion,
  createWizardTheme,
  fit,
  gutter,
  line,
  selectChoice,
  stepHead,
  terminalWidth,
} = require('./setup-wizard-terminal');
const {
  createPlanState,
  planFrame,
  reducePlanState,
  renderApplyFrame,
  selectPlan,
} = require('./setup-wizard-plan-view');
const { ScanPresenter, formatSeconds, probeDetail } = require('./setup-wizard-scan-view');

function readinessStyle(theme, status) {
  if (status === 'ready') return theme.success;
  if (status === 'login-required') return theme.warning;
  if (status === 'incompatible') return theme.danger;
  return theme.dim;
}

function providerRadio(theme, choice, selected) {
  if (choice.disabled) return theme.dim('○');
  return selected ? theme.accent('◉') : '○';
}

function providerChoiceFrame({ theme, title, meta, choices, state, stdout }) {
  const width = terminalWidth(stdout);
  const rows = [stepHead(theme, 'active', title, { meta, width }), gutter(theme)];
  choices.forEach((choice, index) => {
    const selected = index === state.selected;
    const cursor = selected ? theme.accent('▸') : ' ';
    const radio = providerRadio(theme, choice, selected);
    const style = readinessStyle(theme, choice.status);
    const name = selected && !choice.disabled ? theme.bold(choice.label) : style(choice.label);
    rows.push(gutter(theme, fit(`${cursor} ${radio} ${name} ${style(choice.status)}`, width - 3)));
    if (selected && choice.detail) {
      rows.push(gutter(theme, fit(theme.dim(`  ${choice.detail}`), width - 3)));
    }
  });
  rows.push(gutter(theme));
  rows.push(gutter(theme, theme.dim('↑↓ move · ↵ confirm · esc cancel')));
  return rows;
}

class WizardRenderer {
  constructor({ stdout, env = process.env, clock = globalThis, motion } = {}) {
    this.stdout = stdout;
    this.theme = createWizardTheme(stdout, env);
    this.live = new LiveRegion(stdout);
    this.clock = clock;
    this.motion = motion ?? (env.CI !== 'true' && env.TERM !== 'dumb');
  }

  intro() {
    line(this.stdout, this.theme.bold(this.theme.accent('zeroshot')));
    line(
      this.stdout,
      this.theme.dim('Independent execution. Verified changes. · read-only until Apply')
    );
    line(this.stdout);
  }

  scanPresenter() {
    return new ScanPresenter({
      stdout: this.stdout,
      theme: this.theme,
      live: this.live,
      motion: this.motion,
      clock: this.clock,
    });
  }

  async choose({ title, meta, choices, initial, reader, provider = false }) {
    const value = await selectChoice({
      stdout: this.stdout,
      reader,
      live: this.live,
      theme: this.theme,
      title,
      meta,
      choices,
      initial,
      renderFrame: provider ? providerChoiceFrame : undefined,
    });
    if (value === null) return null;
    const choice = choices.find((item) => item.value === value);
    this.live.commit([
      stepHead(this.theme, 'done', title, {
        meta: choice.label,
        width: terminalWidth(this.stdout),
      }),
      gutter(this.theme, choice.detail || choice.label),
      gutter(this.theme),
    ]);
    return value;
  }

  plan(reader, buildModel) {
    return selectPlan({
      stdout: this.stdout,
      reader,
      live: this.live,
      theme: this.theme,
      buildModel,
    });
  }

  applyStarted() {
    this.live.paint(
      renderApplyFrame({ stdout: this.stdout, theme: this.theme, results: [], verified: false })
    );
  }

  applyReceipts(results) {
    for (let count = 1; count <= results.length; count += 1) {
      this.live.paint(
        renderApplyFrame({
          stdout: this.stdout,
          theme: this.theme,
          results: results.slice(0, count),
          verified: false,
        })
      );
    }
  }

  applyVerified(results) {
    this.live.commit(
      renderApplyFrame({ stdout: this.stdout, theme: this.theme, results, verified: true })
    );
  }

  failed(title, error, results = []) {
    this.live.commit(
      renderApplyFrame({ stdout: this.stdout, theme: this.theme, results, failed: true })
    );
    line(this.stdout, `${this.theme.danger('!')} ${title}`);
    line(this.stdout, `  ${error.message}`);
  }

  fatal(title, error) {
    this.live.clear();
    line(this.stdout, `${this.theme.danger('!')} ${title}`);
    line(this.stdout, `  ${error.message}`);
  }

  ready(provider, isolation) {
    const width = terminalWidth(this.stdout);
    this.live.commit([
      stepHead(this.theme, 'done', 'Ready', { meta: `${provider} · ${isolation}`, width }),
      gutter(this.theme, this.theme.bold('zeroshot run "Describe the change"')),
      gutter(this.theme, 'undo: zeroshot setup undo'),
      gutter(this.theme),
    ]);
  }

  cancelled() {
    this.live.clear();
    line(this.stdout, this.theme.dim('Setup cancelled. Nothing was written.'));
  }
}

module.exports = {
  ScanPresenter,
  WizardRenderer,
  createPlanState,
  formatSeconds,
  planFrame,
  probeDetail,
  providerChoiceFrame,
  reducePlanState,
  renderApplyFrame,
  selectPlan,
};
