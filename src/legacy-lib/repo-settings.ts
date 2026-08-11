/**
 * Repo-local settings for zeroshot
 *
 * Optional per-repository config file:
 *   <repoRoot>/.zeroshot/settings.json
 *
 * This complements the global user settings at:
 *   ~/.zeroshot/settings.json
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const { execSync } = childProcess;

type RepoSettings = object;

interface RepoSettingsResult {
  repoRoot: string | null;
  settings: RepoSettings | null;
  settingsPath: string | null;
}

function safeJsonParse(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function getGitRoot(dir: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

function readSettingsFile(filePath: string): RepoSettings | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read repo-local settings if present.
 */
function readRepoSettings(startDir: string): RepoSettingsResult {
  const repoRoot = getGitRoot(startDir);
  if (!repoRoot) {
    return { repoRoot: null, settings: null, settingsPath: null };
  }

  const settingsPath = path.join(repoRoot, '.zeroshot', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { repoRoot, settings: null, settingsPath };
  }

  const settings = readSettingsFile(settingsPath);
  return { repoRoot, settings, settingsPath };
}

/**
 * Write repo-local settings.
 */
function writeRepoSettings(repoRoot: string, settings: object): string {
  const settingsPath = path.join(repoRoot, '.zeroshot', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const serialized = JSON.stringify(settings, null, 2);
  fs.writeFileSync(settingsPath, serialized, 'utf8');
  return settingsPath;
}

export = { readRepoSettings, writeRepoSettings };
