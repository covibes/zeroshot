const assert = require('assert');

const {
  loadClusterConfig,
  buildStartOptions,
  buildTrustedStartOptions,
} = require('../../lib/start-cluster');
const { resolveRunPlan } = require('../../lib/run-plan');

function createOrchestrator(config) {
  const calls = { loadConfig: [] };
  return {
    calls,
    loadConfig(configPath) {
      calls.loadConfig.push(configPath);
      return config;
    },
  };
}

describe('start-cluster config loading', function () {
  it('resolves parameterized config files with defaults before agents are created', function () {
    const orchestrator = createOrchestrator({
      name: 'Parameterized',
      params: {
        planner_level: { type: 'string', default: 'level3' },
        task_type: { type: 'string', default: 'TASK' },
        timeout: { type: 'number', default: 0 },
      },
      agents: [
        {
          id: 'planner',
          role: 'planning',
          modelLevel: '{{planner_level}}',
          timeout: '{{timeout}}',
          prompt: {
            system: 'Plan a {{task_type}}',
          },
        },
      ],
    });

    const config = loadClusterConfig(orchestrator, '/tmp/parameterized.json', {
      defaultProvider: 'claude',
      providerSettings: {},
    });

    assert.strictEqual(config.params, undefined);
    assert.strictEqual(config.defaultProvider, 'claude');
    assert.strictEqual(config.agents[0].modelLevel, 'level3');
    assert.strictEqual(config.agents[0].timeout, 0);
    assert.strictEqual(config.agents[0].prompt.system, 'Plan a TASK');
  });
});

describe('buildStartOptions() runMode', function () {
  it('derives runMode "ship" from pre-transform mergedOptions', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { ship: true } });
    assert.strictEqual(result.runMode, 'ship');
  });

  it('derives runMode "pr+docker" even though transformed output has no .pr/.docker keys', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { pr: true, docker: true } });
    assert.strictEqual(result.runMode, 'pr+docker');
    assert.strictEqual(result.pr, undefined);
    assert.strictEqual(result.docker, undefined);
  });

  it('returns null runMode when no isolation flags are set', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: {} });
    assert.strictEqual(result.runMode, null);
  });
});

describe('buildStartOptions() isolation (single producer via run plan)', function () {
  it('derives isolation=true / worktree=false for --docker', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { docker: true } });
    assert.strictEqual(result.isolation, true);
    assert.strictEqual(result.worktree, false);
  });

  it('derives worktree=true / isolation=false for --pr (worktree delivery)', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { pr: true } });
    assert.strictEqual(result.isolation, false);
    assert.strictEqual(result.worktree, true);
  });

  it('folds settings.defaultIsolation into the plan', function () {
    const result = buildStartOptions({
      clusterId: 'c1',
      options: {},
      settings: { defaultIsolation: 'docker' },
    });
    assert.strictEqual(result.isolation, true);
    assert.strictEqual(result.worktree, false);
    assert.strictEqual(result.runMode, 'docker');
  });

  it('isolation and worktree are mutually exclusive (docker wins over worktree)', function () {
    const result = buildStartOptions({
      clusterId: 'c1',
      options: { worktree: true, docker: true },
    });
    assert.strictEqual(result.isolation, true);
    assert.strictEqual(result.worktree, false);
  });

  it('no isolation when no flags and no settings', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: {}, settings: {} });
    assert.strictEqual(result.isolation, false);
    assert.strictEqual(result.worktree, false);
  });
});

describe('buildStartOptions() autoMerge', function () {
  it('resolves autoMerge=true for --ship', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { ship: true } });
    assert.strictEqual(result.autoMerge, true);
  });

  it('resolves autoMerge=false for --pr', function () {
    const result = buildStartOptions({ clusterId: 'c1', options: { pr: true } });
    assert.strictEqual(result.autoMerge, false);
  });

  it('ignores the dead ZEROSHOT_MERGE env var (removed signal has no effect)', function () {
    process.env.ZEROSHOT_MERGE = '1';
    try {
      const result = buildStartOptions({ clusterId: 'c1', options: { pr: true } });
      assert.strictEqual(result.autoMerge, false);
    } finally {
      delete process.env.ZEROSHOT_MERGE;
    }
  });
});

describe('buildTrustedStartOptions()', function () {
  it('uses only the frozen registry plan and options, ignoring ambient run flags', function () {
    const previous = process.env.ZEROSHOT_RUN_OPTIONS;
    process.env.ZEROSHOT_RUN_OPTIONS = JSON.stringify({ docker: true, ship: true, autoPush: true });
    try {
      const result = buildTrustedStartOptions({
        clusterId: 'trusted-1',
        plan: resolveRunPlan({ worktree: true }),
        options: { cwd: '/registry/repo' },
      });
      assert.strictEqual(result.cwd, '/registry/repo');
      assert.strictEqual(result.worktree, true);
      assert.strictEqual(result.isolation, false);
      assert.strictEqual(result.autoPr, false);
      assert.strictEqual(result.autoPush, false);
    } finally {
      if (previous === undefined) delete process.env.ZEROSHOT_RUN_OPTIONS;
      else process.env.ZEROSHOT_RUN_OPTIONS = previous;
    }
  });

  it('rejects mutable, non-isolated, and non-canonical plans', function () {
    assert.throws(
      () =>
        buildTrustedStartOptions({
          clusterId: 'x',
          plan: { ...resolveRunPlan({ worktree: true }) },
        }),
      /frozen canonical run plan/
    );
    assert.throws(
      () => buildTrustedStartOptions({ clusterId: 'x', plan: resolveRunPlan({}) }),
      /requires worktree or docker isolation/
    );
    assert.throws(
      () =>
        buildTrustedStartOptions({
          clusterId: 'x',
          plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: true }),
        }),
      /not canonical/
    );
  });
});
