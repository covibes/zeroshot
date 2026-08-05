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

function completion(line) {
  const fragment = line.trim().split(/\s+/).length;
  const result = runCli(['--compbash', '--compgen', String(fragment), '', line]);
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean);
}

function isCommandToken(token) {
  return token.split('|').every((name) => {
    if (name.length === 0) return false;
    return [...name].every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-';
    });
  });
}

function visibleHelpCommands(args) {
  const result = runCli([...args, '--help']);
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout
    .split('\nExamples:')[0]
    .split('\n')
    .map((line) =>
      line.startsWith('  ') && line[2] !== ' ' ? line.slice(2).split(/\s+/, 1)[0] : ''
    )
    .filter(isCommandToken);
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

  it('rejects implicit run shorthand', function () {
    const implicit = runCli(['123']);
    assert.notStrictEqual(implicit.status, 0);
    assert.match(implicit.stderr, /unknown command ['‘]123['’]/);
    assert.doesNotMatch(implicit.stderr, /Start a multi-agent cluster/);
  });

  it('keeps hidden compatibility commands fail-closed', function () {
    const result = runCli(['watch']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /TUI is not included/);
  });
});

describe('CLI help snapshots', function () {
  it('keeps the exact visible root help surface intentional', function () {
    assert.deepStrictEqual(visibleHelpCommands([]), [
      'run',
      'setup',
      'task',
      'schedule',
      'schedules',
      'unschedule',
      'scheduler',
      'cmdproof',
      'settings',
      'providers',
      'config',
      'agents',
      'list|ls',
      'status',
      'inspect',
      'logs',
      'attach',
      'stop',
      'kill',
      'resume',
      'finish',
      'kill-all',
      'export',
      'clean',
      'gc',
      'purge',
      'update',
    ]);
  });

  it('keeps the exact visible task and settings help surfaces intentional', function () {
    assert.deepStrictEqual(visibleHelpCommands(['task']), ['run', 'list|ls', 'help']);
    assert.deepStrictEqual(visibleHelpCommands(['settings']), ['list', 'get', 'set', 'reset']);
  });
});

describe('CLI completion snapshots', function () {
  it('keeps root completion in parity with visible commands and aliases', function () {
    assert.deepStrictEqual(completion('zeroshot '), [
      'run',
      'task',
      'cmdproof',
      'list',
      'ls',
      'status',
      'inspect',
      'logs',
      'stop',
      'kill',
      'attach',
      'kill-all',
      'export',
      'resume',
      'finish',
      'clean',
      'gc',
      'purge',
      'schedule',
      'schedules',
      'unschedule',
      'scheduler',
      'settings',
      'providers',
      'setup',
      'update',
      'config',
      'agents',
      '-V',
      '--version',
      '-q',
      '--quiet',
      '-h',
      '--help',
    ]);
  });

  it('keeps nested completion in parity with subcommand help', function () {
    assert.deepStrictEqual(completion('zeroshot task '), [
      'run',
      'list',
      'ls',
      'help',
      '-h',
      '--help',
    ]);
    assert.deepStrictEqual(completion('zeroshot settings '), [
      'list',
      'get',
      'set',
      'reset',
      '-h',
      '--help',
    ]);
  });

  it('keeps the run option candidate set intentional', function () {
    assert.deepStrictEqual(completion('zeroshot run '), [
      '--config',
      '-G',
      '--github',
      '-L',
      '--gitlab',
      '-J',
      '--jira',
      '-D',
      '--devops',
      '-N',
      '--linear',
      '--docker',
      '--worktree',
      '--no-isolation',
      '--docker-image',
      '--mount',
      '--no-mounts',
      '--container-home',
      '--pr',
      '--ship',
      '--pr-base',
      '--merge-queue',
      '--close-issue',
      '--provider',
      '--model',
      '--strict-schema',
      '--workers',
      '--sim',
      '-d',
      '--detach',
      '-h',
      '--help',
    ]);
  });
});
