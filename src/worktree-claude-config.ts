import fs = require('fs');
import os = require('os');
import path = require('path');
import worktreeToolingEnv = require('./worktree-tooling-env');

const { resolveWorktreeRoot } = worktreeToolingEnv;

type MutableRecord = Record<string, unknown>;

interface HookCommand {
  type?: string;
  command?: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: readonly HookCommand[];
}

interface OverlayOptions {
  includeDangerousGit?: boolean;
}

interface WorktreeOptions {
  worktreePath?: string;
  cwd?: string;
}

const CLAUDE_DIRNAME = '.claude';
const MCP_BASENAME = '.mcp.json';
const SETTINGS_BASENAME = 'settings.json';
const OVERLAY_PREFIX = 'zeroshot-claude-settings-';
const CLAUDE_SETTINGS_ENV = 'ZEROSHOT_CLAUDE_SETTINGS_FILE';
const CLAUDE_MCP_CONFIG_ENV = 'ZEROSHOT_CLAUDE_MCP_CONFIG_FILE';
const ASK_USER_HOOK = 'block-ask-user-question.py';
const DANGEROUS_GIT_HOOK = 'block-dangerous-git.py';

function isMutableRecord(value: unknown): value is MutableRecord {
  return typeof value === 'object' && value !== null;
}

function isHookEntries(value: unknown): value is HookEntry[] {
  return Array.isArray(value);
}

function readSettings(settingsPath: string): MutableRecord {
  if (!fs.existsSync(settingsPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse Claude settings overlay ${settingsPath}: ${message}`);
  }
  if (!isMutableRecord(parsed)) {
    throw new TypeError(`Claude settings overlay ${settingsPath} must contain an object.`);
  }
  return parsed;
}

function writeSettings(settingsPath: string, settings: MutableRecord): void {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function requireTargetClaudeDir(targetClaudeDir: unknown): string {
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

function copyHookScript(targetClaudeDir: string, hookScriptName: string): string {
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

function ensurePreToolUseHooks(settings: MutableRecord): HookEntry[] {
  let hooks = settings.hooks;
  if (!hooks) {
    hooks = {};
    settings.hooks = hooks;
  }
  if (!isMutableRecord(hooks)) {
    throw new TypeError('Claude settings hooks must be an object.');
  }

  let preToolUse = hooks.PreToolUse;
  if (!preToolUse) {
    preToolUse = [];
    hooks.PreToolUse = preToolUse;
  }
  if (!isHookEntries(preToolUse)) {
    throw new TypeError('Claude settings hooks.PreToolUse must be an array.');
  }
  return preToolUse;
}

function ensureAskUserQuestionHook(targetClaudeDir: unknown): void {
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

function ensureDangerousGitHook(targetClaudeDir: unknown): void {
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

function prepareClaudeSettingsOverlay(options: OverlayOptions = {}): string {
  const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), OVERLAY_PREFIX));
  fs.chmodSync(overlayDir, 0o700);
  try {
    ensureAskUserQuestionHook(overlayDir);
    if (options.includeDangerousGit) ensureDangerousGitHook(overlayDir);
    return path.join(overlayDir, SETTINGS_BASENAME);
  } catch (error) {
    fs.rmSync(overlayDir, { recursive: true, force: true });
    throw error;
  }
}

function cleanupClaudeSettingsOverlay(settingsPath: unknown): boolean {
  if (!isCanonicalClaudeSettingsOverlayPath(settingsPath)) return false;

  const overlayDir = path.dirname(settingsPath);
  if (!fs.existsSync(overlayDir)) return true;
  if (!isClaudeSettingsOverlayPath(settingsPath)) return false;

  fs.rmSync(overlayDir, { recursive: true, force: true });
  return true;
}

function isCanonicalClaudeSettingsOverlayPath(settingsPath: unknown): settingsPath is string {
  if (typeof settingsPath !== 'string' || !settingsPath) return false;
  const resolvedSettingsPath = path.resolve(settingsPath);
  const overlayDir = path.dirname(resolvedSettingsPath);
  return (
    resolvedSettingsPath === settingsPath &&
    path.basename(resolvedSettingsPath) === SETTINGS_BASENAME &&
    path.dirname(overlayDir) === path.resolve(os.tmpdir()) &&
    path.basename(overlayDir).startsWith(OVERLAY_PREFIX)
  );
}

function isClaudeSettingsOverlayPath(
  settingsPath: unknown,
  platform: NodeJS.Platform = process.platform
): settingsPath is string {
  if (!isCanonicalClaudeSettingsOverlayPath(settingsPath)) return false;

  const overlayDir = path.dirname(settingsPath);
  try {
    const stat = fs.lstatSync(overlayDir);
    const ownedByProcess = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    const privateMode = platform === 'win32' || (stat.mode & 0o777) === 0o700;
    return stat.isDirectory() && !stat.isSymbolicLink() && ownedByProcess && privateMode;
  } catch {
    return false;
  }
}

function isCanonicalClaudeSettingsOverlayDirectory(overlayDir: unknown): overlayDir is string {
  if (
    typeof overlayDir !== 'string' ||
    !overlayDir ||
    path.resolve(overlayDir) !== overlayDir
  ) {
    return false;
  }
  return isCanonicalClaudeSettingsOverlayPath(path.join(overlayDir, SETTINGS_BASENAME));
}

function isClaudeSettingsOverlayDirectory(overlayDir: unknown): overlayDir is string {
  return (
    typeof overlayDir === 'string' &&
    Boolean(overlayDir) &&
    isClaudeSettingsOverlayPath(path.join(overlayDir, SETTINGS_BASENAME))
  );
}

function resolveRepoMcpConfigPath(options: WorktreeOptions = {}): string | null {
  const worktreeRoot = resolveWorktreeRoot(options.worktreePath || options.cwd);
  if (!worktreeRoot) return null;

  const candidates = [
    path.join(worktreeRoot, MCP_BASENAME),
    path.join(worktreeRoot, CLAUDE_DIRNAME, MCP_BASENAME),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveContainerMcpConfigPath(options: WorktreeOptions = {}): string | null {
  const worktreeRoot = resolveWorktreeRoot(options.worktreePath || options.cwd);
  const hostConfigPath = resolveRepoMcpConfigPath(options);
  if (!worktreeRoot || !hostConfigPath) return null;

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

export = {
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
