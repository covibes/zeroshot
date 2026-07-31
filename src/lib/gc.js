/**
 * Garbage collection for orphaned zeroshot worktrees and database files.
 *
 * Standalone module with ZERO dependencies on Orchestrator or IsolationManager.
 * All operations are synchronous so it can be called from any context
 * (CLI, createWorktree pre-flight, etc.) without async concerns.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readClustersFileSync } = require('../../lib/clusters-registry');

const DEFAULT_STORAGE_DIR = path.join(os.homedir(), '.zeroshot');
const PROVIDER_STATE_DIR = path.join(os.tmpdir(), 'zeroshot-provider-state');

/** Cluster ID pattern: adjective-noun-number (e.g., "flying-jungle-51") */
const CLUSTER_ID_PATTERN = /^[a-z]+-[a-z]+-\d+$/;

function isClusterDir(entry) {
  return entry.isDirectory() && CLUSTER_ID_PATTERN.test(entry.name);
}

function resolveActiveClusterIdFromEnv() {
  const clusterId = process.env.ZEROSHOT_CLUSTER_ID;
  if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
    return null;
  }
  const normalized = clusterId.trim();
  return CLUSTER_ID_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Read known cluster IDs from clusters.json (synchronous, no locking).
 * @param {string} storageDir
 * @returns {Set<string>}
 */
function readKnownClusterIds(storageDir) {
  const ids = new Set();
  try {
    const raw = readClustersFileSync(storageDir);
    for (const id of Object.keys(raw)) ids.add(id);
  } catch {
    // Corrupt/missing — treat as empty (safe: nothing deleted incorrectly)
  }
  return ids;
}

function resolveStorageAndKnownIds(storageDirOrOptions = DEFAULT_STORAGE_DIR) {
  const options =
    typeof storageDirOrOptions === 'string'
      ? { storageDir: storageDirOrOptions }
      : storageDirOrOptions || {};
  const storageDir = options.storageDir || DEFAULT_STORAGE_DIR;
  const knownIds = readKnownClusterIds(storageDir);
  const activeClusterId = resolveActiveClusterIdFromEnv();
  if (activeClusterId) {
    knownIds.add(activeClusterId);
  }
  if (options.extraKnownIds) {
    for (const id of options.extraKnownIds) knownIds.add(id);
  }
  return { storageDir, knownIds };
}

/**
 * Count orphaned worktree directories (for error messages).
 * @param {string|{storageDir?: string, extraKnownIds?: Set<string>}} [storageDirOrOptions]
 */
function countOrphanedWorktrees(storageDirOrOptions = DEFAULT_STORAGE_DIR) {
  const { storageDir, knownIds } = resolveStorageAndKnownIds(storageDirOrOptions);
  const worktreeDir = path.join(storageDir, 'worktrees');
  if (!fs.existsSync(worktreeDir)) return 0;
  try {
    return fs
      .readdirSync(worktreeDir, { withFileTypes: true })
      .filter((e) => isClusterDir(e) && !knownIds.has(e.name)).length;
  } catch {
    return 0;
  }
}

/** Try to remove a single file. Returns error string or null. */
function tryUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
    return null;
  } catch (err) {
    return err.message;
  }
}

/** Try to remove a directory tree. Returns error string or null. */
function tryRmdir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return null;
  } catch (err) {
    return err.message;
  }
}

/** Find repo root from a worktree's .git file (gitdir pointer). */
function findRepoRootFromWorktree(worktreeDir) {
  let entries;
  try {
    entries = fs.readdirSync(worktreeDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dotGit = path.join(worktreeDir, entry.name, '.git');
    try {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)/);
      if (!match) continue;
      // gitdir: /repo/.git/worktrees/<name> → resolve to /repo
      const repoRoot = path.resolve(match[1].trim(), '..', '..', '..');
      if (fs.existsSync(path.join(repoRoot, '.git'))) return repoRoot;
    } catch {
      continue;
    }
  }
  return null;
}

/** Best-effort git worktree prune. */
function pruneGitWorktrees(worktreeDir) {
  const repoRoot = findRepoRootFromWorktree(worktreeDir);
  if (!repoRoot) return;
  try {
    require('child_process').execSync('git worktree prune', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    // Best effort
  }
}

/**
 * Garbage-collect orphaned worktree directories and database files.
 *
 * @param {object} [options]
 * @param {string} [options.storageDir]
 * @param {Set<string>} [options.extraKnownIds]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.removeDbFiles] - Defaults to false when ZEROSHOT_CLUSTER_ID is set, else true
 * @returns {{ orphanedWorktrees: string[], orphanedDbs: string[], orphanedProviderState: string[], errors: string[] }}
 */
function gcOrphanedWorktrees(options = {}) {
  const storageDir = options.storageDir || DEFAULT_STORAGE_DIR;
  const dryRun = options.dryRun || false;
  const activeClusterId = resolveActiveClusterIdFromEnv();
  const removeDbFiles =
    typeof options.removeDbFiles === 'boolean' ? options.removeDbFiles : activeClusterId === null;
  const worktreeDir = path.join(storageDir, 'worktrees');
  const result = { orphanedWorktrees: [], orphanedDbs: [], orphanedProviderState: [], errors: [] };

  const { knownIds } = resolveStorageAndKnownIds({
    storageDir,
    extraKnownIds: options.extraKnownIds,
  });

  collectOrphanedWorktrees(worktreeDir, knownIds, dryRun, result);
  if (removeDbFiles) {
    collectOrphanedDbFiles(storageDir, knownIds, dryRun, result);
  }
  collectOrphanedProviderStateDirs(knownIds, dryRun, result);

  if (!dryRun && result.orphanedWorktrees.length > 0) {
    pruneGitWorktrees(worktreeDir);
  }

  return result;
}

function collectOrphanedWorktrees(worktreeDir, knownIds, dryRun, result) {
  if (!fs.existsSync(worktreeDir)) return;
  let entries;
  try {
    entries = fs.readdirSync(worktreeDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`Failed to read worktree dir: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (!isClusterDir(entry) || knownIds.has(entry.name)) continue;
    result.orphanedWorktrees.push(entry.name);
    if (dryRun) continue;
    const err = tryRmdir(path.join(worktreeDir, entry.name));
    if (err) result.errors.push(`Failed to remove worktree ${entry.name}: ${err}`);
  }
}

function collectOrphanedDbFiles(storageDir, knownIds, dryRun, result) {
  let entries;
  try {
    entries = fs.readdirSync(storageDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = entry.match(/^(.+)\.(db|db-wal|db-shm)$/);
    if (!match || knownIds.has(match[1])) continue;
    result.orphanedDbs.push(entry);
    if (dryRun) continue;
    const err = tryUnlink(path.join(storageDir, entry));
    if (err) result.errors.push(`Failed to remove db file ${entry}: ${err}`);
  }
}

/** Validator isolation runs under `<clusterId>-validators` (see agent-lifecycle.js). */
function providerStateBaseClusterId(entryName) {
  return entryName.endsWith('-validators') ? entryName.slice(0, -'-validators'.length) : entryName;
}

/**
 * Sweep `os.tmpdir()/zeroshot-provider-state/<clusterId>` directories left behind by
 * IsolationManager._applyProviderStateMounts. These are normally removed by
 * IsolationManager.cleanup(), but a crash or force-kill before cleanup runs can orphan them —
 * this is the backstop, mirroring the worktree/db sweeps above.
 */
function collectOrphanedProviderStateDirs(knownIds, dryRun, result) {
  if (!fs.existsSync(PROVIDER_STATE_DIR)) return;
  let entries;
  try {
    entries = fs.readdirSync(PROVIDER_STATE_DIR, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`Failed to read provider-state dir: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || knownIds.has(providerStateBaseClusterId(entry.name))) continue;
    result.orphanedProviderState.push(entry.name);
    if (dryRun) continue;
    const err = tryRmdir(path.join(PROVIDER_STATE_DIR, entry.name));
    if (err) result.errors.push(`Failed to remove provider-state dir ${entry.name}: ${err}`);
  }
}

/**
 * Get disk space info for a path.
 * @param {string} dirPath
 * @returns {{ available: number, total: number, usagePercent: number } | null}
 */
function getDiskSpace(dirPath) {
  try {
    const stats = fs.statfsSync(dirPath);
    const available = stats.bavail * stats.bsize;
    const total = stats.blocks * stats.bsize;
    const usagePercent = total > 0 ? ((total - available) / total) * 100 : 0;
    return { available, total, usagePercent };
  } catch {
    return null;
  }
}

module.exports = { gcOrphanedWorktrees, countOrphanedWorktrees, getDiskSpace, CLUSTER_ID_PATTERN };
