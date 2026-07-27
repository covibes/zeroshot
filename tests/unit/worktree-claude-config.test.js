const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cleanupClaudeSettingsOverlay,
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
    assert.ok(
      fs.existsSync(path.join(path.dirname(settingsPath), 'hooks', 'block-ask-user-question.py'))
    );
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
    assert.ok(fs.existsSync(unrelatedSettingsPath));
    assert.strictEqual(cleanupClaudeSettingsOverlay(settingsPath), true);
    assert.ok(!fs.existsSync(path.dirname(settingsPath)));
  });

  it('resolves repository MCP config independently of the Claude settings overlay', function () {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-worktree-'));
    tempDirs.push(worktreeRoot);
    fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: test\n', 'utf8');
    fs.mkdirSync(path.join(worktreeRoot, '.claude'), { recursive: true });
    const mcpPath = path.join(worktreeRoot, '.claude', '.mcp.json');
    fs.writeFileSync(mcpPath, '{"mcpServers":{}}\n', 'utf8');

    assert.strictEqual(resolveRepoMcpConfigPath({ worktreePath: worktreeRoot }), mcpPath);
  });
});
