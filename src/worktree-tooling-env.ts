import fs = require('fs');
import path = require('path');
interface WorktreeToolingOptions {
  worktreePath?: string;
  cwd?: string;
}
interface ToolingMetadata {
  toolBinDir?: unknown;
}
const TOOLING_METADATA_RELATIVE_PATH = path.join('.zeroshot', 'tooling-env.json');
const DEFAULT_TOOL_BIN_RELATIVE_PATHS = ['.zeroshot/bin', '.worktree-tool-bin'];
const FALLBACK_BIN_PREFIX = '.worktree-tool-bin.';
function isToolingMetadata(value: unknown): value is ToolingMetadata {
  return typeof value === 'object' && value !== null;
}
function pathKeyForEnv(env: NodeJS.ProcessEnv): string {
  if (Object.prototype.hasOwnProperty.call(env, 'PATH')) {
    return 'PATH';
  }
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}
function resolveExistingRealPath(candidatePath: string): string | null {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return null;
  }
}
function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidateRealPath = resolveExistingRealPath(candidatePath);
  const rootRealPath = resolveExistingRealPath(rootPath);
  if (!candidateRealPath || !rootRealPath) {
    return false;
  }
  return (
    candidateRealPath === rootRealPath || candidateRealPath.startsWith(`${rootRealPath}${path.sep}`)
  );
}
function dedupePaths(entries: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const orderedEntries: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    orderedEntries.push(entry);
  }
  return orderedEntries;
}
function hasToolingMetadata(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, TOOLING_METADATA_RELATIVE_PATH));
}
function hasGitEntry(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'));
}
function resolveWorktreeRoot(startDir: string | null | undefined): string | null {
  if (!startDir) {
    return null;
  }
  let currentDir = path.resolve(startDir);
  let nearestGitRoot: string | null = null;
  while (true) {
    if (hasToolingMetadata(currentDir)) {
      return currentDir;
    }
    if (!nearestGitRoot && hasGitEntry(currentDir)) {
      nearestGitRoot = currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return nearestGitRoot;
    }
    currentDir = parentDir;
  }
}
function readToolingMetadata(worktreeRoot: string): ToolingMetadata | null {
  const metadataPath = path.join(worktreeRoot, TOOLING_METADATA_RELATIVE_PATH);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!isToolingMetadata(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function listFallbackBinDirectories(worktreeRoot: string): string[] {
  try {
    return fs
      .readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(FALLBACK_BIN_PREFIX))
      .map((entry) => path.join(worktreeRoot, entry.name));
  } catch {
    return [];
  }
}
function resolveWorktreeToolBinEntries(options: WorktreeToolingOptions = {}): string[] {
  const worktreeRoot = resolveWorktreeRoot(options.worktreePath || options.cwd);
  if (!worktreeRoot) {
    return [];
  }
  const metadata = readToolingMetadata(worktreeRoot);
  const hasExplicitWorktreePath =
    typeof options.worktreePath === 'string' && options.worktreePath.trim().length > 0;
  if (!metadata && !hasExplicitWorktreePath) {
    return [];
  }
  const candidates: string[] = [];
  if (typeof metadata?.toolBinDir === 'string' && metadata.toolBinDir.trim()) {
    candidates.push(metadata.toolBinDir.trim());
  }
  for (const relativePath of DEFAULT_TOOL_BIN_RELATIVE_PATHS) {
    candidates.push(path.join(worktreeRoot, relativePath));
  }
  candidates.push(...listFallbackBinDirectories(worktreeRoot));
  return dedupePaths(candidates).filter((candidatePath) =>
    isWithinRoot(candidatePath, worktreeRoot)
  );
}
function prependWorktreeToolBinToEnv(
  env: NodeJS.ProcessEnv,
  options: WorktreeToolingOptions = {}
): NodeJS.ProcessEnv {
  const toolBinEntries = resolveWorktreeToolBinEntries(options);
  if (toolBinEntries.length === 0) {
    return env;
  }
  const pathKey = pathKeyForEnv(env);
  const existingEntries = (env[pathKey] || '').split(path.delimiter).filter(Boolean);
  env[pathKey] = dedupePaths([...toolBinEntries, ...existingEntries]).join(path.delimiter);
  return env;
}
export = {
  prependWorktreeToolBinToEnv,
  resolveWorktreeRoot,
  resolveWorktreeToolBinEntries,
};
