const assert = require('assert');

const { resolveEffectiveRunPlan, startClusterFromText } = require('../../lib/start-cluster');

function captureStartOptions(settings) {
  const config = { agents: [] };
  const orchestrator = {
    start(_config, _input, startOptions) {
      return startOptions;
    },
  };
  return startClusterFromText({
    orchestrator,
    config,
    clusterId: 'c1',
    text: 'hello',
    options: {},
    settings,
  });
}

describe('resolveEffectiveRunPlan() settings.defaultDelivery (issue #606)', function () {
  it('folds merged defaultDelivery=ship into delivery + autoMerge', function () {
    const plan = resolveEffectiveRunPlan({ ship: true }, {});
    assert.strictEqual(plan.delivery, 'ship');
    assert.strictEqual(plan.autoMerge, true);
    assert.strictEqual(plan.isolation, 'worktree');
  });

  it('folds merged defaultDelivery=pr into delivery without autoMerge', function () {
    const plan = resolveEffectiveRunPlan({ pr: true }, {});
    assert.strictEqual(plan.delivery, 'pr');
    assert.strictEqual(plan.autoMerge, false);
    assert.strictEqual(plan.isolation, 'worktree');
  });

  it('defaults to delivery=none when settings.defaultDelivery is unset', function () {
    const plan = resolveEffectiveRunPlan({}, {});
    assert.strictEqual(plan.delivery, 'none');
    assert.strictEqual(plan.autoMerge, false);
  });

  it('a CLI --pr flag still wins when settings.defaultDelivery=none', function () {
    const plan = resolveEffectiveRunPlan({ pr: true }, { defaultDelivery: 'none' });
    assert.strictEqual(plan.delivery, 'pr');
  });

  it('startClusterFromText folds settings.defaultDelivery into autoPr/autoMerge', function () {
    const result = captureStartOptions({ defaultDelivery: 'ship' });
    assert.strictEqual(result.autoPr, true);
    assert.strictEqual(result.autoMerge, true);
    assert.strictEqual(result.worktree, true);
  });

  it('uses saved worktree isolation when no explicit mode exists', function () {
    const plan = resolveEffectiveRunPlan({}, { defaultIsolation: 'worktree' });
    assert.strictEqual(plan.isolation, 'worktree');
  });

  it('lets explicit CLI and run-options isolation override saved defaults', function () {
    assert.strictEqual(
      resolveEffectiveRunPlan({ worktree: true }, { defaultIsolation: 'docker' }).isolation,
      'worktree'
    );
    process.env.ZEROSHOT_RUN_OPTIONS = JSON.stringify({ docker: true });
    try {
      assert.strictEqual(
        resolveEffectiveRunPlan({}, { defaultIsolation: 'worktree' }).isolation,
        'docker'
      );
      assert.strictEqual(
        resolveEffectiveRunPlan({ worktree: true }, { defaultIsolation: 'docker' }).isolation,
        'worktree'
      );
    } finally {
      delete process.env.ZEROSHOT_RUN_OPTIONS;
    }
  });

  it('uses explicit isolation env before the saved default', function () {
    process.env.ZEROSHOT_DOCKER = '1';
    try {
      assert.strictEqual(
        resolveEffectiveRunPlan({}, { defaultIsolation: 'worktree' }).isolation,
        'docker'
      );
    } finally {
      delete process.env.ZEROSHOT_DOCKER;
    }
  });

  it('--no-isolation overrides a saved default and conflicts with explicit modes', function () {
    assert.strictEqual(
      resolveEffectiveRunPlan({ noIsolation: true }, { defaultIsolation: 'worktree' }).isolation,
      'none'
    );
    for (const mode of ['docker', 'worktree', 'pr', 'ship']) {
      assert.throws(
        () =>
          resolveEffectiveRunPlan(
            { noIsolation: true, [mode]: true },
            { defaultIsolation: 'none' }
          ),
        /--no-isolation conflicts/
      );
    }
  });
});
