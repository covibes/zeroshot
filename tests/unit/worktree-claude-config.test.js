const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cleanupClaudeSettingsOverlay,
  ensureAskUserQuestionHook,
  ensureDangerousGitHook,
  isClaudeSettingsOverlayDirectory,
  isClaudeSettingsOverlayPath,
  prepareClaudeSettingsOverlay,
  resolveRepoMcpConfigPath,
} = require('../../src/worktree-claude-config');

describe('worktree-claude-config', function () {
  const tempDirs = [];
  const settingsOverlays = [];

  afterEach(function () {
    for (const settingsPath of settingsOverlays.splice(0)) {
      cleanupClaudeSettingsOverlay(settingsPath);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates an AskUserQuestion settings overlay for every Claude run', function () {
    const settingsPath = prepareClaudeSettingsOverlay();
    settingsOverlays.push(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(
      settings.hooks.PreToolUse.map((entry) => entry.matcher),
      ['AskUserQuestion']
    );
    assert.strictEqual(fs.statSync(settingsPath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(settingsPath)).mode & 0o777, 0o700);
    assert.ok(
      fs.existsSync(path.join(path.dirname(settingsPath), 'hooks', 'block-ask-user-question.py'))
    );
  });

  it('gives retry and restart runs independently owned overlays', function () {
    const first = prepareClaudeSettingsOverlay();
    const retry = prepareClaudeSettingsOverlay();
    settingsOverlays.push(first, retry);

    assert.notStrictEqual(first, retry);
    assert.ok(fs.existsSync(first));
    assert.ok(fs.existsSync(retry));
    assert.strictEqual(cleanupClaudeSettingsOverlay(first), true);
    assert.ok(!fs.existsSync(path.dirname(first)));
    assert.ok(fs.existsSync(retry), 'cleaning one run must not affect the next run');
  });

  it('rewrites hooks when a cleaned overlay path is reused after many runs', function () {
    const settingsPaths = Array.from({ length: 40 }, () =>
      prepareClaudeSettingsOverlay({ includeDangerousGit: true })
    );
    const reusedDir = path.dirname(settingsPaths[0]);
    for (const settingsPath of settingsPaths) {
      assert.strictEqual(cleanupClaudeSettingsOverlay(settingsPath), true);
    }

    fs.mkdirSync(reusedDir, { recursive: true });
    fs.chmodSync(reusedDir, 0o700);
    fs.writeFileSync(path.join(reusedDir, 'settings.json'), '{}\n', { mode: 0o600 });
    ensureAskUserQuestionHook(reusedDir);
    ensureDangerousGitHook(reusedDir);

    const settings = JSON.parse(fs.readFileSync(path.join(reusedDir, 'settings.json'), 'utf8'));
    assert.deepStrictEqual(
      settings.hooks.PreToolUse.map((entry) => entry.matcher),
      ['AskUserQuestion', 'Bash']
    );
    assert.ok(fs.existsSync(path.join(reusedDir, 'hooks', 'block-ask-user-question.py')));
    assert.ok(fs.existsSync(path.join(reusedDir, 'hooks', 'block-dangerous-git.py')));
    tempDirs.push(reusedDir);
  });

  it('adds the dangerous-git hook only for worktree runs', function () {
    const settingsPath = prepareClaudeSettingsOverlay({ includeDangerousGit: true });
    settingsOverlays.push(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(
      settings.hooks.PreToolUse.map((entry) => entry.matcher),
      ['AskUserQuestion', 'Bash']
    );
    assert.ok(
      fs.existsSync(path.join(path.dirname(settingsPath), 'hooks', 'block-dangerous-git.py'))
    );
  });

  it('only cleans up Zeroshot-owned settings overlays', function () {
    const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-source-'));
    const unrelatedSettingsPath = path.join(unrelatedDir, 'settings.json');
    tempDirs.push(unrelatedDir);
    fs.writeFileSync(unrelatedSettingsPath, '{}\n', 'utf8');

    const settingsPath = prepareClaudeSettingsOverlay();
    assert.ok(fs.existsSync(settingsPath));

    assert.strictEqual(cleanupClaudeSettingsOverlay(unrelatedSettingsPath), false);
    assert.strictEqual(isClaudeSettingsOverlayPath(unrelatedSettingsPath), false);
    assert.strictEqual(isClaudeSettingsOverlayDirectory(unrelatedDir), false);
    assert.ok(fs.existsSync(unrelatedSettingsPath));
    assert.strictEqual(isClaudeSettingsOverlayPath(settingsPath), true);
    assert.strictEqual(isClaudeSettingsOverlayDirectory(path.dirname(settingsPath)), true);
    assert.strictEqual(cleanupClaudeSettingsOverlay(settingsPath), true);
    assert.ok(!fs.existsSync(path.dirname(settingsPath)));
  });

  it('refuses to install safety hooks into arbitrary user directories', function () {
    const askUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-user-ask-'));
    const dangerousGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-user-git-'));
    tempDirs.push(askUserDir, dangerousGitDir);

    assert.throws(
      () => ensureAskUserQuestionHook(askUserDir),
      /Zeroshot-owned Claude settings overlay/
    );
    assert.throws(
      () => ensureDangerousGitHook(dangerousGitDir),
      /Zeroshot-owned Claude settings overlay/
    );
    assert.deepStrictEqual(fs.readdirSync(askUserDir), []);
    assert.deepStrictEqual(fs.readdirSync(dangerousGitDir), []);
  });
  it('rejects predictable overlay-shaped directories without private ownership mode', function () {
    const insecureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'zeroshot-claude-settings-insecure-')
    );
    const insecureSettingsPath = path.join(insecureDir, 'settings.json');
    tempDirs.push(insecureDir);
    fs.chmodSync(insecureDir, 0o755);

    assert.strictEqual(isClaudeSettingsOverlayPath(insecureSettingsPath), false);
    assert.strictEqual(isClaudeSettingsOverlayDirectory(insecureDir), false);
    assert.throws(
      () => ensureAskUserQuestionHook(insecureDir),
      /Zeroshot-owned Claude settings overlay/
    );
    assert.deepStrictEqual(fs.readdirSync(insecureDir), []);
  });


  it('prefers root MCP config and supports the legacy Claude-directory fallback', function () {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-worktree-'));
    tempDirs.push(worktreeRoot);
    fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: test\n', 'utf8');
    fs.mkdirSync(path.join(worktreeRoot, '.claude'), { recursive: true });
    const legacyMcpPath = path.join(worktreeRoot, '.claude', '.mcp.json');
    const rootMcpPath = path.join(worktreeRoot, '.mcp.json');
    fs.writeFileSync(legacyMcpPath, '{"mcpServers":{"legacy":{}}}\n', 'utf8');

    assert.strictEqual(resolveRepoMcpConfigPath({ worktreePath: worktreeRoot }), legacyMcpPath);
    fs.writeFileSync(rootMcpPath, '{"mcpServers":{"root":{}}}\n', 'utf8');
    assert.strictEqual(resolveRepoMcpConfigPath({ worktreePath: worktreeRoot }), rootMcpPath);
  });
});
