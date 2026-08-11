const assert = require('assert');
const runModeModule = require('../lib/run-mode');
const { describeRunMode, resolveRunMode, runModeFromPlan } = runModeModule;

describe('run-mode CommonJS contract', () => {
  it('preserves the exact export surface and function arities', () => {
    assert.deepStrictEqual(Reflect.ownKeys(runModeModule), [
      'resolveRunMode',
      'runModeFromPlan',
      'describeRunMode',
    ]);
    assert.deepStrictEqual(
      Reflect.ownKeys(runModeModule).map((key) => runModeModule[key].length),
      [1, 1, 1]
    );
  });

  it('derives labels directly from canonical plans', () => {
    assert.strictEqual(runModeFromPlan({ isolation: 'docker', delivery: 'ship' }), 'ship+docker');
    assert.strictEqual(runModeFromPlan({ isolation: 'worktree', delivery: 'pr' }), 'pr');
    assert.strictEqual(runModeFromPlan({ isolation: 'none', delivery: 'none' }), null);
  });
});

describe('describeRunMode', () => {
  it('describes ship', () => {
    assert.strictEqual(describeRunMode('ship'), 'ship (worktree + PR + auto-merge)');
  });

  it('describes ship+docker', () => {
    assert.strictEqual(describeRunMode('ship+docker'), 'ship (docker + PR + auto-merge)');
  });

  it('describes pr', () => {
    assert.strictEqual(describeRunMode('pr'), 'pr (worktree + PR)');
  });

  it('describes pr+docker', () => {
    assert.strictEqual(describeRunMode('pr+docker'), 'pr (docker + PR)');
  });

  it('describes docker', () => {
    assert.strictEqual(describeRunMode('docker'), 'docker (isolated container)');
  });

  it('describes worktree', () => {
    assert.strictEqual(describeRunMode('worktree'), 'worktree (isolated branch)');
  });

  it('describes null as local (no isolation)', () => {
    assert.strictEqual(describeRunMode(null), 'local (no isolation)');
  });

  it('describes undefined as local (no isolation)', () => {
    assert.strictEqual(describeRunMode(undefined), 'local (no isolation)');
  });
});

describe('resolveRunMode (lib/run-mode)', () => {
  it('returns "ship" when options.ship is set', () => {
    assert.strictEqual(resolveRunMode({ ship: true }), 'ship');
  });

  it('returns null when no mode flags are set', () => {
    assert.strictEqual(resolveRunMode({}), null);
  });
});
