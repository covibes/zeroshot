const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ClaudeTaskRunner = require('../../src/claude-task-runner');
const {
  CLAUDE_SETTINGS_ENV,
  cleanupClaudeSettingsOverlay,
} = require('../../src/worktree-claude-config');

describe('ClaudeTaskRunner worktree env forwarding', function () {
  /** @type {string[]} */
  let tempDirs = [];
  /** @type {string[]} */
  let settingsOverlays = [];
  let originalClaudeConfigDir;

  beforeEach(function () {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(function () {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    for (const settingsPath of settingsOverlays.splice(0)) {
      cleanupClaudeSettingsOverlay(settingsPath);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves user config while forwarding a per-run hook overlay and worktree tools', function () {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runner-worktree-'));
    const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runner-claude-user-'));
    tempDirs.push(worktreeRoot, userConfigDir);
    const userSettingsPath = path.join(userConfigDir, 'settings.json');
    const userSettings = '{"enabledPlugins":{"example@marketplace":true}}\n';
    fs.writeFileSync(userSettingsPath, userSettings, 'utf8');
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;

    const toolBinDir = path.join(worktreeRoot, '.zeroshot', 'bin');
    const submoduleCwd = path.join(worktreeRoot, 'external', 'zeroshot', 'src');
    fs.mkdirSync(toolBinDir, { recursive: true });
    fs.mkdirSync(submoduleCwd, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, '.zeroshot', 'tooling-env.json'),
      JSON.stringify({
        version: 1,
        worktreeRoot,
        toolBinDir,
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: main-worktree\n', 'utf8');
    fs.writeFileSync(
      path.join(worktreeRoot, 'external', 'zeroshot', '.git'),
      'gitdir: nested-submodule\n',
      'utf8'
    );

    const runner = new ClaudeTaskRunner({ quiet: true });
    const originalPathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

    const spawnEnv = runner._buildSpawnEnv('claude', null, {
      cwd: submoduleCwd,
      worktreePath: worktreeRoot,
    });
    settingsOverlays.push(spawnEnv[CLAUDE_SETTINGS_ENV]);

    const pathEntries = spawnEnv.PATH.split(path.delimiter);
    assert.strictEqual(
      spawnEnv.CLAUDE_CONFIG_DIR,
      userConfigDir,
      'the user config source must remain active'
    );
    assert.ok(spawnEnv[CLAUDE_SETTINGS_ENV], 'Claude runs should receive a settings overlay');
    assert.strictEqual(fs.readFileSync(userSettingsPath, 'utf8'), userSettings);
    const overlaySettings = JSON.parse(fs.readFileSync(spawnEnv[CLAUDE_SETTINGS_ENV], 'utf8'));
    assert.deepStrictEqual(
      overlaySettings.hooks.PreToolUse.map((entry) => entry.matcher),
      ['AskUserQuestion', 'Bash']
    );
    assert.strictEqual(pathEntries[0], toolBinDir);
    for (const entry of originalPathEntries) {
      assert.ok(pathEntries.includes(entry));
    }
  });

  it('forwards max reasoning effort into the detached task invocation', function () {
    const runner = new ClaudeTaskRunner({ quiet: true });
    const args = runner._buildRunArgs({
      context: 'test context',
      providerName: 'claude',
      runOutputFormat: 'stream-json',
      resolvedModelSpec: {
        model: 'claude-opus-4-8',
        reasoningEffort: 'max',
      },
      jsonSchema: null,
    });

    assert.deepStrictEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
      '--model',
      'claude-opus-4-8',
    ]);
    assert.deepStrictEqual(
      args.slice(args.indexOf('--reasoning-effort'), args.indexOf('--reasoning-effort') + 2),
      ['--reasoning-effort', 'max']
    );
  });
});
