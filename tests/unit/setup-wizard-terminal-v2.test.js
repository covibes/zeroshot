const assert = require('assert');
const { EventEmitter } = require('events');

const {
  LiveRegion,
  createSelectionState,
  createWizardTheme,
  displayWidth,
  reduceSelection,
  stepHead,
  stripAnsi,
  terminalWidth,
} = require('../../cli/lib/setup-wizard-terminal');
const {
  ScanPresenter,
  createPlanState,
  planFrame,
  reducePlanState,
} = require('../../cli/lib/setup-wizard-view');

function outputHarness({ columns = 80, isTTY = true, colorDepth = 8 } = {}) {
  const chunks = [];
  const stdout = new EventEmitter();
  stdout.columns = columns;
  stdout.isTTY = isTTY;
  stdout.getColorDepth = () => colorDepth;
  stdout.write = (value) => {
    chunks.push(String(value));
    return true;
  };
  return { stdout, output: () => chunks.join('') };
}

function planModel() {
  const executionWrite = {
    decisionId: 'defaultIsolation',
    path: 'defaultIsolation',
    from: null,
    to: 'worktree',
    targetFile: '/home/test/.zeroshot/settings.json',
  };
  const updateWrite = {
    decisionId: 'updatePolicy',
    path: 'updatePolicy',
    from: null,
    to: 'notify',
    targetFile: '/home/test/.zeroshot/settings.json',
  };
  return {
    groups: [
      {
        id: 'execution',
        title: 'Execution defaults',
        required: true,
        enabled: true,
        writes: [executionWrite],
      },
      {
        id: 'updates',
        title: 'Update notifications',
        required: false,
        enabled: true,
        writes: [updateWrite],
      },
    ],
    writes: [executionWrite, updateWrite],
    files: ['/home/test/.zeroshot/settings.json'],
  };
}

describe('setup wizard terminal primitives', function () {
  it('moves across enabled choices and never confirms a disabled row', function () {
    const choices = [
      { value: 'a', disabled: false },
      { value: 'b', disabled: true },
      { value: 'c', disabled: false },
    ];
    let state = createSelectionState(choices, 0);
    state = reduceSelection(state, 'down', choices);
    assert.strictEqual(state.selected, 2);
    state = reduceSelection(state, 'up', choices);
    assert.strictEqual(state.selected, 0);
    assert.deepStrictEqual(reduceSelection(state, '2', choices), state);
    assert.strictEqual(reduceSelection(state, 'enter', choices).value, 'a');
  });

  it('supports horizontal actions, q cancellation, and resize as a no-op', function () {
    const choices = [
      { value: 'apply', disabled: false },
      { value: 'cancel', disabled: false },
    ];
    let state = createSelectionState(choices, 0);
    state = reduceSelection(state, 'right', choices, 'horizontal');
    assert.strictEqual(state.selected, 1);
    assert.strictEqual(reduceSelection(state, 'enter', choices, 'horizontal').value, 'cancel');
    assert.strictEqual(reduceSelection(state, 'q', choices).status, 'cancelled');
    assert.deepStrictEqual(reduceSelection(state, 'resize', choices), state);
  });

  it('repaints a live region instead of appending another active frame', function () {
    const { stdout, output } = outputHarness();
    const live = new LiveRegion(stdout);
    live.paint(['first', 'second']);
    live.paint(['replacement']);
    live.commit(['done']);
    assert.match(output(), /first\nsecond/);
    assert.ok(output().includes('\x1b[2K'));
    assert.match(output(), /replacement/);
    assert.match(output(), /done\n$/);
  });

  it('keeps headers inside 40, 80, and 120-column terminals', function () {
    const plain = createWizardTheme(outputHarness({ isTTY: false }).stdout, { NO_COLOR: '1' });
    for (const columns of [40, 80, 120]) {
      const width = terminalWidth({ columns });
      const header = stepHead(plain, 'active', 'Provider', {
        meta: 'worktree-compatible',
        width,
      });
      assert.ok(displayWidth(header) <= width + 1, `${columns}: ${stripAnsi(header)}`);
    }
    assert.strictEqual(terminalWidth({ columns: 40 }), 38);
    assert.strictEqual(terminalWidth({ columns: 80 }), 74);
    assert.strictEqual(terminalWidth({ columns: 120 }), 74);
  });

  it('honors NO_COLOR, dumb terminals, 256 color, and truecolor', function () {
    const tty = outputHarness({ colorDepth: 24 }).stdout;
    const plain = createWizardTheme(tty, { NO_COLOR: '1' });
    const dumb = createWizardTheme(tty, { TERM: 'dumb' });
    const ansi256 = createWizardTheme(tty, { FORCE_COLOR: '2' });
    const truecolor = createWizardTheme(tty, { FORCE_COLOR: '3' });
    assert.strictEqual(plain.accent('x'), 'x');
    assert.strictEqual(dumb.bold('x'), 'x');
    assert.ok(ansi256.accent('x').includes('\x1b['));
    assert.match(truecolor.accent('x'), /38;2;194;36;12/);
  });
});

describe('setup wizard scan animation', function () {
  it('advances and clears its timer through an injected fake clock', function () {
    const { stdout, output } = outputHarness({ columns: 80, isTTY: true });
    const theme = createWizardTheme(stdout, { NO_COLOR: '1' });
    const live = new LiveRegion(stdout);
    let tick;
    let cleared = false;
    const timer = { unref() {} };
    const clock = {
      setInterval(callback, interval) {
        assert.strictEqual(interval, 80);
        tick = callback;
        return timer;
      },
      clearInterval(handle) {
        assert.strictEqual(handle, timer);
        cleared = true;
      },
    };
    const presenter = new ScanPresenter({ stdout, theme, live, motion: true, clock });
    presenter.handle({ type: 'start', probes: [{ kind: 'git' }], elapsedMs: 0 });
    tick();
    assert.match(output(), /0\.1s · 0\/1/);
    presenter.handle({
      type: 'complete',
      id: 'git',
      kind: 'git',
      elapsedMs: 80,
      result: { isRepo: true, branch: 'main', clean: true },
    });
    presenter.commit({
      elapsedMs: 80,
      probes: {
        git: { isRepo: true, branch: 'main', clean: true },
        docker: { available: true },
        issue: { authenticated: true },
        'provider:codex': { available: true },
      },
    });
    assert.strictEqual(cleared, true);
    assert.match(output(), /1 providers found/);
  });
});

describe('setup wizard plan reducer and golden frames', function () {
  it('toggles optional groups, moves to actions, and chooses Apply or Cancel', function () {
    const groups = planModel().groups;
    let state = createPlanState(groups);
    state = reducePlanState(state, 'down', groups);
    state = reducePlanState(state, 'space', groups);
    assert.strictEqual(state.enabled.updates, false);
    state = reducePlanState(state, 'enter', groups);
    assert.strictEqual(state.focus, groups.length);
    state = reducePlanState(state, 'right', groups);
    assert.strictEqual(state.action, 1);
    assert.strictEqual(reducePlanState(state, 'enter', groups).status, 'cancelled');

    state = createPlanState(groups);
    state = reducePlanState(state, 'enter', groups);
    assert.strictEqual(reducePlanState(state, 'enter', groups).status, 'apply');
  });

  it('matches the stable 80-column plain-text plan frame', function () {
    const { stdout } = outputHarness({ columns: 80, isTTY: false });
    const theme = createWizardTheme(stdout, { NO_COLOR: '1' });
    const model = planModel();
    const frame = planFrame({
      stdout,
      theme,
      model,
      state: createPlanState(model.groups),
    });
    assert.deepStrictEqual(frame, [
      ` * Plan ${'·'.repeat(47)} 1 file · 2 settings`,
      ' |',
      ' | ▸ [x] Execution defaults · required',
      ' |   + defaultIsolation = worktree',
      ' |   [x] Update notifications',
      ' |   + updatePolicy = notify',
      ' |',
      ' | files: /home/test/.zeroshot/settings.json',
      ' |',
      ' |   Apply     Cancel',
      ' | ↑↓ move · space toggle · ←→ choose · ↵ continue',
    ]);
  });

  it('fits plan frames at 40, 80, and 120 columns without ANSI drift', function () {
    for (const columns of [40, 80, 120]) {
      const { stdout } = outputHarness({ columns, isTTY: false });
      const theme = createWizardTheme(stdout, { NO_COLOR: '1' });
      const model = planModel();
      const frame = planFrame({ stdout, theme, model, state: createPlanState(model.groups) });
      const width = terminalWidth(stdout);
      assert.ok(
        frame.every((row) => displayWidth(row) <= width + 1),
        `${columns}: ${frame.join('\n')}`
      );
    }
  });
});
