const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLAUDE_SETTINGS_ENV,
  cleanupClaudeSettingsOverlay,
  prepareClaudeSettingsOverlay,
} = require('../../src/worktree-claude-config');

describe('task runner Claude cleanup ownership', function () {
  let originalSettingsPath;
  const cleanupPaths = [];

  beforeEach(function () {
    originalSettingsPath = process.env[CLAUDE_SETTINGS_ENV];
  });

  afterEach(function () {
    if (originalSettingsPath === undefined) {
      delete process.env[CLAUDE_SETTINGS_ENV];
    } else {
      process.env[CLAUDE_SETTINGS_ENV] = originalSettingsPath;
    }
    for (const cleanupPath of cleanupPaths.splice(0)) {
      if (path.basename(cleanupPath) === 'settings.json') {
        cleanupClaudeSettingsOverlay(cleanupPath);
      } else {
        fs.rmSync(cleanupPath, { recursive: true, force: true });
      }
    }
  });

  it('attaches the owned overlay directory to the Claude command spec', async function () {
    const { attachClaudeOverlayCleanup } = await import('../../task-lib/runner.js');
    const settingsPath = prepareClaudeSettingsOverlay();
    cleanupPaths.push(settingsPath);
    process.env[CLAUDE_SETTINGS_ENV] = settingsPath;

    const command = attachClaudeOverlayCleanup(
      { binary: 'claude', args: [], cleanup: [], cleanupMetadata: [] },
      'claude'
    );
    assert.deepStrictEqual(command.cleanup, [path.dirname(settingsPath)]);
    assert.deepStrictEqual(command.cleanupMetadata, [
      {
        kind: 'temp-directory',
        provider: 'claude',
        path: path.dirname(settingsPath),
        reason: 'settings-overlay',
      },
    ]);
  });

  it('does not accept an arbitrary settings path as recursive cleanup', async function () {
    const { attachClaudeOverlayCleanup } = await import('../../task-lib/runner.js');
    const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-user-settings-'));
    cleanupPaths.push(unrelatedDir);
    process.env[CLAUDE_SETTINGS_ENV] = path.join(unrelatedDir, 'settings.json');
    fs.writeFileSync(process.env[CLAUDE_SETTINGS_ENV], '{}\n');

    const command = { binary: 'claude', args: [], cleanup: [], cleanupMetadata: [] };
    assert.strictEqual(attachClaudeOverlayCleanup(command, 'claude'), command);
  });
});
