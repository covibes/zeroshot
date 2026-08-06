const { getProviderMetadata } = require('../../lib/provider-names');
const { WIZARD_SPINNER, fit, gutter, stepHead, terminalWidth } = require('./setup-wizard-terminal');

function formatSeconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function probeLabel(spec) {
  if (spec.kind === 'git') return 'Repository';
  if (spec.kind === 'docker') return 'Docker';
  if (spec.kind === 'issue') return 'Issue host';
  return getProviderMetadata(spec.id).displayName;
}

function gitProbeDetail(result) {
  if (!result.isRepo) return 'not a git repository';
  return `${result.branch || 'detached'}${result.clean === true ? ' · clean' : ''}`;
}

function issueProbeDetail(result) {
  if (!result.installed) return 'gh unavailable';
  return result.authenticated ? 'GitHub authenticated' : 'GitHub login required';
}

function providerProbeDetail(result) {
  if (!result.available) return result.commandAvailable ? 'probe failed' : 'not installed';
  if (result.authStatus === 'login-required') return 'login required';
  return result.path || 'available';
}

function probeDetail(event) {
  const result = event.result;
  if (event.kind === 'git') return gitProbeDetail(result);
  if (event.kind === 'docker')
    return result.available ? 'available' : result.error || 'unavailable';
  if (event.kind === 'issue') return issueProbeDetail(result);
  return providerProbeDetail(result);
}

class ScanPresenter {
  constructor({ stdout, theme, live, motion, clock }) {
    this.stdout = stdout;
    this.theme = theme;
    this.live = live;
    this.motion = motion;
    this.clock = clock;
    this.specs = [];
    this.completed = new Map();
    this.frameIndex = 0;
    this.elapsedMs = 0;
    this.timer = null;
  }

  handle(event) {
    this.elapsedMs = event.elapsedMs || 0;
    if (event.type === 'start') {
      this.specs = event.probes;
      this.startTimer();
    } else if (event.type === 'complete') {
      this.completed.set(event.id, event);
    }
    this.paint();
  }

  startTimer() {
    if (!this.motion || this.timer) return;
    this.timer = this.clock.setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % WIZARD_SPINNER.length;
      this.elapsedMs += 80;
      this.paint();
    }, 80);
    this.timer.unref?.();
  }

  stopTimer() {
    if (!this.timer) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  paint() {
    if (this.specs.length === 0) return;
    const width = terminalWidth(this.stdout);
    const done = this.completed.size;
    const spinner = this.motion ? WIZARD_SPINNER[this.frameIndex] : '*';
    const rows = [
      stepHead(this.theme, 'active', 'Scan', {
        meta: `${formatSeconds(this.elapsedMs)} · ${done}/${this.specs.length}`,
        width,
      }),
      gutter(this.theme),
    ];
    for (const spec of this.specs) {
      const id = spec.id ? `provider:${spec.id}` : spec.kind;
      const event = this.completed.get(id);
      const glyph = event ? this.theme.success('v') : this.theme.accent(spinner);
      const detail = event ? this.theme.dim(probeDetail(event)) : this.theme.dim('checking');
      rows.push(gutter(this.theme, fit(`${glyph} ${probeLabel(spec)} · ${detail}`, width - 3)));
    }
    this.live.paint(rows);
  }

  summaryRows({ probes, elapsedMs, width }) {
    const providerResults = Object.entries(probes)
      .filter(([id]) => id.startsWith('provider:'))
      .map(([, result]) => result);
    const ready = providerResults.filter((result) => result.available).length;
    const unavailable = providerResults.length - ready;
    const cleanliness = probes.git.clean ? 'clean repository' : 'local changes';
    const gitSummary = probes.git.isRepo
      ? `git ${probes.git.branch || 'detached'} · ${cleanliness}`
      : 'not a git repository';
    const dockerSummary = probes.docker.available ? 'available' : 'unavailable';
    const issueSummary = probes.issue.authenticated ? 'authenticated' : 'not authenticated';
    return [
      stepHead(this.theme, 'done', 'Scan', {
        meta: `${formatSeconds(elapsedMs)} · ${ready} providers found`,
        width,
      }),
      gutter(this.theme, fit(gitSummary, width - 3)),
      gutter(this.theme, fit(`docker ${dockerSummary}`, width - 3)),
      gutter(
        this.theme,
        fit(
          `providers ${ready} found · ${unavailable} unavailable · GitHub ${issueSummary}`,
          width - 3
        )
      ),
      gutter(this.theme),
    ];
  }

  commit({ probes, elapsedMs }) {
    this.stopTimer();
    this.live.commit(this.summaryRows({ probes, elapsedMs, width: terminalWidth(this.stdout) }));
  }

  clear() {
    this.stopTimer();
    this.live.clear();
  }
}

module.exports = { ScanPresenter, formatSeconds, probeDetail };
