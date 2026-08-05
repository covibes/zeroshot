const assert = require('assert');
const { PassThrough } = require('stream');

const { buildWizardDecisions, parseKeys, runSetupWizard } = require('../../cli/lib/setup-wizard');

function planFixture(overrides = {}) {
  const plan = {
    facts: {
      node: { version: 'v24.0.0', packageVersion: '1.2.3' },
      git: { isRepo: true, branch: 'main' },
      docker: { available: true },
      providers: {
        codex: {
          available: true,
          displayName: 'Codex',
          path: '/usr/bin/codex',
          installInstructions: 'npm install -g @openai/codex',
        },
      },
    },
    recommended: {
      defaultProvider: 'codex',
      'providerLevel.codex': {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
      },
      defaultIsolation: 'worktree',
      defaultIssueSource: 'github',
      defaultDelivery: 'none',
      updatePolicy: 'notify',
      dockerMounts: ['gh', 'git', 'ssh'],
      dockerEnvPassthrough: [],
    },
  };
  return {
    ...plan,
    ...overrides,
    facts: { ...plan.facts, ...overrides.facts },
    recommended: { ...plan.recommended, ...overrides.recommended },
  };
}

function terminalHarness() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  const rawModes = [];
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
    rawModes.push(value);
  };
  const chunks = [];
  const stdout = {
    isTTY: true,
    write(value) {
      chunks.push(String(value));
      return true;
    },
  };
  return { stdin, stdout, rawModes, output: () => chunks.join('') };
}

function wizardDeps(plan, calls) {
  return {
    buildSetupPlan: () => plan,
    loadSettings: () => ({}),
    settingsFileExists: () => false,
    readRepoSettings: () => ({ settings: null }),
    applyDecisionValues: (request) => {
      calls.applies.push(request);
      return [];
    },
    mutateSettings: (mutator) => {
      const settings = {};
      mutator(settings);
      calls.mutations.push(settings);
    },
  };
}

describe('setup wizard terminal flow', function () {
  it('parses arrows, number keys, Enter, Escape, and Ctrl+C', function () {
    assert.deepStrictEqual(parseKeys(Buffer.from('\x1b[A\x1b[B2\r\x1b\x03')), [
      'up',
      'down',
      '2',
      'enter',
      'escape',
      'ctrl-c',
    ]);
  });

  it('cancels without writes and restores raw mode and cursor state', async function () {
    const terminal = terminalHarness();
    const calls = { applies: [], mutations: [] };
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: {},
      deps: wizardDeps(planFixture(), calls),
    });
    terminal.stdin.write('\x1b');
    const result = await running;

    assert.strictEqual(result.status, 'cancelled');
    assert.deepStrictEqual(calls, { applies: [], mutations: [] });
    assert.deepStrictEqual(terminal.rawModes, [true, false]);
    assert.ok(terminal.output().includes('\x1b[?25l'));
    assert.ok(terminal.output().includes('\x1b[?25h'));
  });

  it('applies default selections, then writes the setup marker', async function () {
    const terminal = terminalHarness();
    const calls = { applies: [], mutations: [] };
    const running = runSetupWizard({
      cwd: '/repo',
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      env: {},
      deps: wizardDeps(planFixture(), calls),
    });
    terminal.stdin.write('11\r');
    const result = await running;

    assert.strictEqual(result.status, 'applied');
    assert.strictEqual(calls.applies.length, 1);
    assert.deepStrictEqual(calls.mutations, [{ setupVersion: 1 }]);
    assert.match(terminal.output(), /Setup complete/);
    assert.match(terminal.output(), /zeroshot run <input>/);
    assert.match(terminal.output(), /zeroshot providers setup codex/);
    assert.match(terminal.output(), /zeroshot --help/);
  });
});

describe('setup wizard decisions', function () {
  it('derives canonical provider, level, isolation, and safe defaults', function () {
    const plan = planFixture();
    assert.deepStrictEqual(buildWizardDecisions(plan, 'codex', 'worktree'), {
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

  it('includes Docker defaults only when Docker is selected', function () {
    const decisions = buildWizardDecisions(planFixture(), 'codex', 'docker');
    assert.deepStrictEqual(decisions.dockerMounts, ['gh', 'git', 'ssh']);
    assert.deepStrictEqual(decisions.dockerEnvPassthrough, []);
  });
});

describe('setup wizard provider availability', function () {
  it('prints registry installation actions and writes nothing when no provider is usable', async function () {
    const terminal = terminalHarness();
    const calls = { applies: [], mutations: [] };
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
      env: {},
      deps: wizardDeps(plan, calls),
    });

    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(calls, { applies: [], mutations: [] });
    assert.match(terminal.output(), /Codex/);
    assert.match(terminal.output(), /npm install -g @openai\/codex/);
    assert.match(terminal.output(), /Run zeroshot setup after installing a provider\./);
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
