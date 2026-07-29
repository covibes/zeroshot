const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveWorktreeRoot } = require('./worktree-tooling-env');

const CLAUDE_DIRNAME = '.claude';
const MCP_BASENAME = '.mcp.json';
const SETTINGS_BASENAME = 'settings.json';
const OVERLAY_PREFIX = 'zeroshot-claude-settings-';
const CLAUDE_SETTINGS_ENV = 'ZEROSHOT_CLAUDE_SETTINGS_FILE';
const CLAUDE_MCP_CONFIG_ENV = 'ZEROSHOT_CLAUDE_MCP_CONFIG_FILE';
const ASK_USER_HOOK = 'block-ask-user-question.py';
const DANGEROUS_GIT_HOOK = 'block-dangerous-git.py';


function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse Claude settings overlay ${settingsPath}: ${error.message}`);
  }
}

function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function requireTargetClaudeDir(targetClaudeDir) {
  if (typeof targetClaudeDir !== 'string' || !targetClaudeDir) {
    throw new Error('Claude safety hooks require an explicit per-run settings directory.');
  }
  if (!isClaudeSettingsOverlayDirectory(targetClaudeDir)) {
    throw new Error(
      `Claude safety hooks require a Zeroshot-owned Claude settings overlay: ${targetClaudeDir}`
    );
  }
  return targetClaudeDir;
}

function copyHookScript(targetClaudeDir, hookScriptName) {
  const hooksDir = path.join(targetClaudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const sourcePath = path.join(__dirname, '..', 'cluster-hooks', hookScriptName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Claude safety hook ${hookScriptName} is missing from the Zeroshot installation.`
    );
  }

  const destinationPath = path.join(hooksDir, hookScriptName);
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, 0o755);
  return destinationPath;
}

function ensurePreToolUseHooks(settings) {
  settings.hooks ||= {};
  settings.hooks.PreToolUse ||= [];
  return settings.hooks.PreToolUse;
}

function ensureAskUserQuestionHook(targetClaudeDir) {
  const overlayDir = requireTargetClaudeDir(targetClaudeDir);

  const hookScriptPath = copyHookScript(overlayDir, ASK_USER_HOOK);
  const settingsPath = path.join(overlayDir, SETTINGS_BASENAME);
  const settings = readSettings(settingsPath);
  const hooks = ensurePreToolUseHooks(settings);
  const hasHook = hooks.some(
    (entry) =>
      entry.matcher === 'AskUserQuestion' ||
      entry.hooks?.some((hook) => hook.command?.includes(ASK_USER_HOOK))
  );

  if (!hasHook) {
    hooks.push({
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: hookScriptPath }],
    });
    writeSettings(settingsPath, settings);
  }

}

function ensureDangerousGitHook(targetClaudeDir) {
  const overlayDir = requireTargetClaudeDir(targetClaudeDir);

  const hookScriptPath = copyHookScript(overlayDir, DANGEROUS_GIT_HOOK);
  const settingsPath = path.join(overlayDir, SETTINGS_BASENAME);
  const settings = readSettings(settingsPath);
  const hooks = ensurePreToolUseHooks(settings);
  const hasHook = hooks.some(
    (entry) =>
      entry.matcher === 'Bash' &&
      entry.hooks?.some((hook) => hook.command?.includes(DANGEROUS_GIT_HOOK))
  );

  if (!hasHook) {
    hooks.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: hookScriptPath }],
    });
    writeSettings(settingsPath, settings);
  }

}

function prepareClaudeSettingsOverlay(options = {}) {
  const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), OVERLAY_PREFIX));
  fs.chmodSync(overlayDir, 0o700);
  try {
    ensureAskUserQuestionHook(overlayDir);
    if (options.includeDangerousGit) {
      ensureDangerousGitHook(overlayDir);
    }
    return path.join(overlayDir, SETTINGS_BASENAME);
  } catch (error) {
    fs.rmSync(overlayDir, { recursive: true, force: true });
    throw error;
  }
}

function cleanupClaudeSettingsOverlay(settingsPath) {
  if (!isClaudeSettingsOverlayPath(settingsPath)) {
    return false;
  }

  const overlayDir = path.dirname(path.resolve(settingsPath));
  fs.rmSync(overlayDir, { recursive: true, force: true });
  return true;
}

function isCanonicalClaudeSettingsOverlayPath(settingsPath) {
  if (typeof settingsPath !== 'string' || !settingsPath) {
    return false;
  }
  const resolvedSettingsPath = path.resolve(settingsPath);
  const overlayDir = path.dirname(resolvedSettingsPath);
  return (
    resolvedSettingsPath === settingsPath &&
    path.basename(resolvedSettingsPath) === SETTINGS_BASENAME &&
    path.dirname(overlayDir) === path.resolve(os.tmpdir()) &&
    path.basename(overlayDir).startsWith(OVERLAY_PREFIX)
  );
}

function isClaudeSettingsOverlayPath(settingsPath) {
  if (!isCanonicalClaudeSettingsOverlayPath(settingsPath)) {
    return false;
  }

  const resolvedSettingsPath = path.resolve(settingsPath);
  const overlayDir = path.dirname(resolvedSettingsPath);

  try {
    const stat = fs.lstatSync(overlayDir);
    const ownedByProcess =
      typeof process.getuid !== 'function' || stat.uid === process.getuid();
    return stat.isDirectory() && !stat.isSymbolicLink() && ownedByProcess && (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function isCanonicalClaudeSettingsOverlayDirectory(overlayDir) {
  if (typeof overlayDir !== 'string' || !overlayDir) {
    return false;
  }
  return isCanonicalClaudeSettingsOverlayPath(path.join(overlayDir, SETTINGS_BASENAME));
}

function isClaudeSettingsOverlayDirectory(overlayDir) {
  if (typeof overlayDir !== 'string' || !overlayDir) {
    return false;
  }
  return isClaudeSettingsOverlayPath(path.join(overlayDir, SETTINGS_BASENAME));
}

/**
 * Resolve the repo's MCP config for a given worktree/cwd. The project-root
 * `.mcp.json` is Claude's current convention. `.claude/.mcp.json` remains a
 * deliberate compatibility fallback for repositories created by Zeroshot's
 * earlier worktree integration.
 */
function resolveRepoMcpConfigPath(options = {}) {
  const worktreeRoot = resolveWorktreeRoot(options.worktreePath || options.cwd);
  if (!worktreeRoot) {
    return null;
  }

  const candidates = [
    path.join(worktreeRoot, MCP_BASENAME),
    path.join(worktreeRoot, CLAUDE_DIRNAME, MCP_BASENAME),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveContainerMcpConfigPath(options = {}) {
  const worktreeRoot = resolveWorktreeRoot(options.worktreePath || options.cwd);
  const hostConfigPath = resolveRepoMcpConfigPath(options);
  if (!worktreeRoot || !hostConfigPath) {
    return null;
  }

  const relativePath = path.relative(worktreeRoot, hostConfigPath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Repository MCP config is outside the mounted workspace: ${hostConfigPath}`);
  }

  return path.posix.join('/workspace', relativePath.split(path.sep).join('/'));
}

module.exports = {
  CLAUDE_MCP_CONFIG_ENV,
  CLAUDE_SETTINGS_ENV,
  cleanupClaudeSettingsOverlay,
  ensureAskUserQuestionHook,
  ensureDangerousGitHook,
  isCanonicalClaudeSettingsOverlayDirectory,
  isCanonicalClaudeSettingsOverlayPath,
  isClaudeSettingsOverlayDirectory,
  isClaudeSettingsOverlayPath,
  prepareClaudeSettingsOverlay,
  resolveContainerMcpConfigPath,
  resolveRepoMcpConfigPath,
};
