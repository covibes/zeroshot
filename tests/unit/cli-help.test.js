const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', '..', 'cli', 'index.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

describe('curated CLI help', function () {
  it('uses provider-neutral copy and the production command groups', function () {
    const result = runCli(['--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Independent executor–verifier orchestration for software changes\./
    );
    const headings = result.stdout.split('\n').filter((line) => line.endsWith(':'));
    for (const heading of [
      'Start:',
      'Observe:',
      'Control:',
      'Configure:',
      'Automation:',
      'Maintenance:',
    ]) {
      assert.ok(headings.includes(heading), `missing help group ${heading}`);
    }
  });

  it('groups run options and removes stale destructive copy', function () {
    const runHelp = runCli(['run', '--help']);
    assert.strictEqual(runHelp.status, 0, runHelp.stderr);
    let previousIndex = -1;
    for (const heading of ['Input:', 'Isolation:', 'Delivery:', 'Provider:', 'Runtime:']) {
      const index = runHelp.stdout.indexOf(`\n${heading}\n`);
      assert.ok(index > previousIndex, `missing or out-of-order run option group ${heading}`);
      previousIndex = index;
    }

    const rootHelp = runCli(['--help']);
    assert.strictEqual(rootHelp.status, 0, rootHelp.stderr);
    assert.doesNotMatch(rootHelp.stdout, /maxModel|Automation levels|NUCLEAR/);
    assert.match(rootHelp.stdout, /delete all Zeroshot run data/);
  });

  it('hides internal and compatibility commands from root help', function () {
    const result = runCli(['--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    const helpLines = result.stdout.split('\n').map((line) => line.trimStart());
    for (const command of [
      'get-log-path',
      'get-task-id-by-spawn-token',
      'watch',
      'tui',
      'claude',
    ]) {
      assert.ok(
        !helpLines.some((line) => line === command || line.startsWith(`${command} `)),
        `hidden command leaked into help: ${command}`
      );
    }
  });

  it('keeps hidden compatibility commands fail-closed', function () {
    const result = runCli(['watch']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /TUI is not included/);
  });
});
