/**
 * Detects whether the npm global bin directory is on PATH, so we can warn
 * the user when `npm install -g` succeeds but the `zeroshot` binary is
 * unreachable (e.g. non-standard Node installs whose global bin dir isn't
 * exported).
 */

import path = require('path');

interface PathCheckOptions {
  readonly installPrefix?: string;
  readonly pathEnv?: string;
}

interface UpdateCheckerModule {
  readonly getInstallPrefix: (options: PathCheckOptions) => string;
}

type PathCheckResult =
  | { readonly onPath: true; readonly binDir: null }
  | { readonly onPath: boolean; readonly binDir: string };

function isUpdateCheckerModule(value: unknown): value is UpdateCheckerModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getInstallPrefix' in value &&
    typeof value.getInstallPrefix === 'function'
  );
}

function getGlobalBinDir(installPrefix: string): string {
  if (process.platform === 'win32') {
    return installPrefix;
  }

  return path.join(installPrefix, 'bin');
}

function isDirOnPath(dir: string, pathEnv: string = process.env.PATH || ''): boolean {
  const resolvedDir = path.resolve(dir);

  return pathEnv
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => path.resolve(entry) === resolvedDir);
}

function getPathExportLine(dir: string): string {
  return `export PATH="${dir}:$PATH"`;
}

function checkBinDirOnPath(options: PathCheckOptions = {}): PathCheckResult {
  if (process.platform === 'win32') {
    return { onPath: true, binDir: null };
  }

  try {
    const updateChecker: unknown = require('../cli/lib/update-checker');
    if (!isUpdateCheckerModule(updateChecker)) {
      throw new TypeError('update-checker must export getInstallPrefix');
    }
    const { getInstallPrefix } = updateChecker;
    const installPrefix = options.installPrefix || getInstallPrefix(options);
    const binDir = getGlobalBinDir(installPrefix);

    return { onPath: isDirOnPath(binDir, options.pathEnv), binDir };
  } catch {
    return { onPath: true, binDir: null };
  }
}

function printPathWarning(binDir: string): void {
  console.error(
    `[zeroshot] Warning: ${binDir} is not on your PATH — the 'zeroshot' command may not be found.`
  );
  console.error(`  ${getPathExportLine(binDir)}`);
  console.error(
    '  Add this line to your shell profile (~/.zshrc, ~/.bashrc, or ~/.profile) to fix this permanently.'
  );
}

export = {
  getGlobalBinDir,
  isDirOnPath,
  getPathExportLine,
  checkBinDirOnPath,
  printPathWarning,
};
