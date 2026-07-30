const assert = require('assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { isStartupUpdateEligible, resolveRunMode } = require('../cli/index.js');

describe('resolveRunMode', () => {
  it('returns "ship" when options.ship is set', () => {
    assert.strictEqual(resolveRunMode({ ship: true }), 'ship');
  });

  it('returns "ship+docker" when ship and docker are both set', () => {
    assert.strictEqual(resolveRunMode({ ship: true, docker: true }), 'ship+docker');
  });

  it('returns "pr" when options.pr is set', () => {
    assert.strictEqual(resolveRunMode({ pr: true }), 'pr');
  });

  it('returns "pr+docker" when pr and docker are both set', () => {
    assert.strictEqual(resolveRunMode({ pr: true, docker: true }), 'pr+docker');
  });

  it('returns "docker" when only options.docker is set', () => {
    assert.strictEqual(resolveRunMode({ docker: true }), 'docker');
  });

  it('returns "worktree" when only options.worktree is set', () => {
    assert.strictEqual(resolveRunMode({ worktree: true }), 'worktree');
  });

  it('returns null when no mode flags are set', () => {
    assert.strictEqual(resolveRunMode({}), null);
  });

  it('prioritizes ship over pr, docker, and worktree', () => {
    assert.strictEqual(
      resolveRunMode({ ship: true, pr: true, docker: true, worktree: true }),
      'ship+docker'
    );
  });
});

describe('startup update option integration', function () {
  const tty = { isTTY: true };
  const options = {
    currentVersion: '1.2.3',
    packageName: '@the-open-engine/zeroshot',
    stdin: tty,
    stdout: tty,
    stderr: tty,
    env: {},
  };

  it('uses the built CLI metadata for mixed global and export short options', function () {
    assert.strictEqual(
      isStartupUpdateEligible(['export', 'nonexistent', '-qfjson'], options),
      false
    );
    assert.strictEqual(isStartupUpdateEligible(['export', 'nonexistent', '-fq'], options), true);
    assert.strictEqual(isStartupUpdateEligible(['export', 'nonexistent', '-oq'], options), true);
  });

  it('uses the final repeated production option value', function () {
    assert.strictEqual(
      isStartupUpdateEligible(
        ['export', 'nonexistent', '--format', 'markdown', '--format', 'json'],
        options
      ),
      false
    );
    assert.strictEqual(
      isStartupUpdateEligible(
        ['export', 'nonexistent', '--format', 'json', '--format', 'markdown'],
        options
      ),
      true
    );
  });

  it('combines global flags with compatible subcommand booleans only', function () {
    assert.strictEqual(isStartupUpdateEligible(['logs', 'nonexistent', '-fq'], options), false);
    assert.strictEqual(isStartupUpdateEligible(['run', 'hello', '-qX'], options), true);
    assert.strictEqual(isStartupUpdateEligible(['run', 'hello', '-query'], options), true);
  });

  it('does not parse prompt text or tokens after the option terminator', function () {
    assert.strictEqual(
      isStartupUpdateEligible(['run', 'Explain -qfjson and -query'], options),
      true
    );
    assert.strictEqual(
      isStartupUpdateEligible(['export', 'nonexistent', '--', '-qfjson'], options),
      true
    );
  });

  it('accepts reasoning effort on task run', function () {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../cli/index.js'),
        'task',
        'run',
        'prompt',
        '--reasoning-effort',
        'max',
        '--help',
      ],
      { encoding: 'utf8' }
    );

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--reasoning-effort <effort>/);
  });
});
