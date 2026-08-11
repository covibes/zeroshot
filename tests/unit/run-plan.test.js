/**
 * Test: resolveRunPlan (the single canonical run-mode resolver)
 *
 * Verifies isolation/delivery/autoMerge for every flag combination, and — the
 * point of #582 — that the run-mode LABEL (resolveRunMode) is a pure view of the
 * same plan, so the label and the behavior cannot drift.
 */

const assert = require('assert');
const runPlanModule = require('../../lib/run-plan');
const { resolveRunPlan } = runPlanModule;
const { resolveRunMode } = require('../../lib/run-mode');

describe('resolveRunPlan CommonJS contract', function () {
  it('preserves the CommonJS export contract', function () {
    assert.deepStrictEqual(Reflect.ownKeys(runPlanModule), ['resolveRunPlan']);
    assert.strictEqual(resolveRunPlan.length, 0);
  });
});

describe('resolveRunPlan', function () {
  it('resolves {} to no isolation, no delivery', function () {
    assert.deepStrictEqual(resolveRunPlan({}), {
      isolation: 'none',
      delivery: 'none',
      autoMerge: false,
    });
  });

  it('resolves {worktree: true}', function () {
    assert.deepStrictEqual(resolveRunPlan({ worktree: true }), {
      isolation: 'worktree',
      delivery: 'none',
      autoMerge: false,
    });
  });

  it('resolves {docker: true}', function () {
    assert.deepStrictEqual(resolveRunPlan({ docker: true }), {
      isolation: 'docker',
      delivery: 'none',
      autoMerge: false,
    });
  });

  it('resolves {pr: true} to pr delivery, no auto-merge', function () {
    assert.deepStrictEqual(resolveRunPlan({ pr: true }), {
      isolation: 'worktree',
      delivery: 'pr',
      autoMerge: false,
    });
  });

  it('resolves {ship: true} to ship delivery with auto-merge', function () {
    assert.deepStrictEqual(resolveRunPlan({ ship: true }), {
      isolation: 'worktree',
      delivery: 'ship',
      autoMerge: true,
    });
  });

  it('resolves {pr: true, docker: true}', function () {
    assert.deepStrictEqual(resolveRunPlan({ pr: true, docker: true }), {
      isolation: 'docker',
      delivery: 'pr',
      autoMerge: false,
    });
  });

  it('resolves {ship: true, docker: true}', function () {
    assert.deepStrictEqual(resolveRunPlan({ ship: true, docker: true }), {
      isolation: 'docker',
      delivery: 'ship',
      autoMerge: true,
    });
  });

  it('treats an explicit autoMerge as ship-equivalent (future --auto-merge flag)', function () {
    // Regression for the normalizeRunOptions overwrite bug: an explicit
    // autoMerge intent must survive, not be reset to false.
    assert.deepStrictEqual(resolveRunPlan({ pr: true, autoMerge: true }), {
      isolation: 'worktree',
      delivery: 'ship',
      autoMerge: true,
    });
  });

  it('returns a frozen object', function () {
    assert.strictEqual(Object.isFrozen(resolveRunPlan({})), true);
  });

  it('defaults options to {} when called with no arguments', function () {
    assert.deepStrictEqual(resolveRunPlan(), {
      isolation: 'none',
      delivery: 'none',
      autoMerge: false,
    });
  });
});

describe('resolveRunMode is a view of resolveRunPlan (cannot drift)', function () {
  // Expected label derived ONLY from the plan. If resolveRunMode ever grows an
  // independent cascade again, this binding breaks.
  function labelFromPlan(options) {
    const { isolation, delivery } = resolveRunPlan(options);
    const suffix = isolation === 'docker' ? '+docker' : '';
    if (delivery === 'ship') return `ship${suffix}`;
    if (delivery === 'pr') return `pr${suffix}`;
    if (isolation === 'docker') return 'docker';
    if (isolation === 'worktree') return 'worktree';
    return null;
  }

  it('agrees with the plan across all 16 flag combinations', function () {
    const flags = ['worktree', 'docker', 'pr', 'ship'];
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const options = {};
      flags.forEach((f, i) => {
        if (mask & (1 << i)) options[f] = true;
      });
      assert.strictEqual(
        resolveRunMode(options),
        labelFromPlan(options),
        `run-mode label drifted from plan for ${JSON.stringify(options)}`
      );
    }
  });
});
