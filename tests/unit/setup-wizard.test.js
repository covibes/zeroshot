const assert = require('assert');

const {
  buildWizardDecisions,
  buildWizardPlanModel,
  parseKeys,
  runSetupWizard,
} = require('../../cli/lib/setup-wizard');
const { emptyCalls, planFixture, terminalHarness, wizardDeps } = require('./setup-wizard-fixtures');

describe('setup wizard terminal flow', function () {
  it('parses arrows, vim keys, space, numbers, Enter, Escape, q, and Ctrl+C', function () {
    assert.deepStrictEqual(parseKeys(Buffer.from('\x1b[A\x1b[B\x1b[C\x1b[Djkhl 2\rq\x1b\x03')), [
      'up',
      'down',
      'right',
      'left',
      'down',
      'up',
      'left',
      'right',
      'space',
      '2',
      'enter',
      'q',
      'escape',
      'ctrl-c',
    ]);
  });

  it('cancels before Apply with zero writes and restores terminal state', async function () {
    const terminal = terminalHarness();
    const calls = emptyCalls();
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: { NO_COLOR: '1' },
      deps: wizardDeps(planFixture(), calls),
    });
    terminal.stdin.write('\x1b');
    const result = await running;

    assert.strictEqual(result.status, 'cancelled');
    assert.deepStrictEqual(calls, emptyCalls());
    assert.deepStrictEqual(terminal.rawModes, [true, false]);
    assert.match(terminal.output(), /Nothing was written/);
    assert.ok(terminal.output().includes('\x1b[?25l'));
    assert.ok(terminal.output().includes('\x1b[?25h'));
  });

  it('applies approved defaults, verifies preflight, then writes the setup marker', async function () {
    const terminal = terminalHarness();
    const calls = emptyCalls();
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: { NO_COLOR: '1' },
      deps: wizardDeps(planFixture(), calls),
    });
    terminal.stdin.write('11\r\r');
    const result = await running;

    assert.strictEqual(result.status, 'applied');
    assert.strictEqual(calls.applies.length, 1);
    assert.strictEqual(calls.preflights.length, 1);
    assert.strictEqual(calls.preflights[0].requireGit, true);
    assert.strictEqual(calls.mutations.at(-1).setupVersion, 1);
    assert.match(terminal.output(), /◆ Ready/);
    assert.match(terminal.output(), /zeroshot run "Describe the change"/);
    assert.match(terminal.output(), /zeroshot setup undo/);
  });
});

describe('setup wizard apply failures', function () {
  it('renders an apply failure without Ready and restores terminal state', async function () {
    const terminal = terminalHarness();
    const calls = emptyCalls();
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: { NO_COLOR: '1' },
      deps: wizardDeps(planFixture(), calls, { applyError: new Error('disk is read-only') }),
    });
    terminal.stdin.write('11\r\r');
    const result = await running;

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.applied, false);
    assert.doesNotMatch(terminal.output(), /◆ Ready/);
    assert.match(terminal.output(), /disk is read-only/);
    assert.deepStrictEqual(terminal.rawModes, [true, false]);
  });

  it('does not write the setup marker when persisted preflight fails', async function () {
    const terminal = terminalHarness();
    const calls = emptyCalls();
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: { NO_COLOR: '1' },
      deps: wizardDeps(planFixture(), calls, {
        preflight: { valid: false, errors: ['provider cannot execute'], warnings: [] },
      }),
    });
    terminal.stdin.write('11\r\r');
    const result = await running;

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(calls.mutations.length, 0);
    assert.match(terminal.output(), /provider cannot execute/);
    assert.doesNotMatch(terminal.output(), /◆ Ready/);
  });
});

describe('setup wizard decisions and preview', function () {
  it('derives canonical provider, level, isolation, and safe defaults', function () {
    assert.deepStrictEqual(buildWizardDecisions(planFixture(), 'codex', 'worktree'), {
      defaultProvider: 'codex',
      'providerLevel.codex': {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
      },
      defaultIsolation: 'worktree',
      defaultDelivery: 'none',
      defaultIssueSource: 'github',
      updatePolicy: 'notify',
    });
  });

  it('includes Docker defaults only for Docker and omits disabled optional groups', function () {
    const decisions = buildWizardDecisions(planFixture(), 'codex', 'docker', {
      'issue-source': false,
      updates: false,
    });
    assert.deepStrictEqual(decisions.dockerMounts, ['gh', 'git', 'ssh']);
    assert.deepStrictEqual(decisions.dockerEnvPassthrough, []);
    assert.ok(!Object.hasOwn(decisions, 'defaultIssueSource'));
    assert.ok(!Object.hasOwn(decisions, 'updatePolicy'));
  });

  it('builds exact grouped writes and target files from canonical decision paths', function () {
    const model = buildWizardPlanModel({
      plan: planFixture(),
      settings: { providerSettings: {} },
      settingsFile: '/home/test/.zeroshot/settings.json',
      provider: 'codex',
      isolation: 'worktree',
      enabledGroups: { 'issue-source': false, updates: true },
    });
    assert.deepStrictEqual(
      model.groups.map((group) => group.id),
      ['execution', 'issue-source', 'updates']
    );
    assert.strictEqual(model.groups[0].required, true);
    assert.strictEqual(model.groups[1].enabled, false);
    assert.ok(model.writes.every((write) => write.scope === 'global'));
    assert.ok(model.writes.some((write) => write.path === 'defaultIsolation'));
    assert.ok(model.writes.some((write) => write.path === 'providerSettings.codex'));
    assert.deepStrictEqual(model.files, ['/home/test/.zeroshot/settings.json']);
  });
});

describe('setup wizard provider availability', function () {
  it('prints registry installation actions and writes nothing when no provider is usable', async function () {
    const terminal = terminalHarness();
    const calls = emptyCalls();
    const plan = planFixture({
      facts: {
        providers: {
          codex: {
            available: false,
            displayName: 'Codex',
            path: null,
            installInstructions: 'npm install -g @openai/codex',
          },
        },
      },
    });
    const result = await runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: { NO_COLOR: '1' },
      deps: wizardDeps(plan, calls),
    });

    assert.strictEqual(result.status, 'no-provider');
    assert.deepStrictEqual(calls, emptyCalls());
    assert.match(terminal.output(), /Codex: unavailable/);
    assert.match(terminal.output(), /npm install -g @openai\/codex/);
    assert.match(terminal.output(), /Run `zeroshot setup` again/);
  });

  it('rejects non-TTY invocation with non-interactive setup actions', async function () {
    const output = [];
    const result = await runSetupWizard({
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (value) => output.push(String(value)) },
    });
    assert.strictEqual(result.exitCode, 1);
    assert.match(output.join(''), /setup plan/);
    assert.match(output.join(''), /setup apply/);
  });
});
