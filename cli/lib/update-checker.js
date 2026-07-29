/**
 * Update Checker - cached startup notices and the explicit npm updater.
 *
 * Automatic startup work is notification-only and stale-while-revalidate.
 * Installation remains exclusive to the explicit `zeroshot update` command.
 */

const https = require('https');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSettings, mutateSettings } = require('../../lib/settings');

const NEW_PACKAGE_NAME = '@the-open-engine/zeroshot';
const LEGACY_PACKAGE_NAME = '@covibes/zeroshot';
const NEW_PACKAGE_SPEC = `${NEW_PACKAGE_NAME}@latest`;

// 24 hours in milliseconds
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Timeout for npm registry fetch (5 seconds)
const FETCH_TIMEOUT_MS = 5000;

// npm registry URL
const REGISTRY_URL = `https://registry.npmjs.org/${NEW_PACKAGE_NAME}/latest`;

const MAX_RESPONSE_BYTES = 64 * 1024;
const STABLE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

let inFlightRefresh = null;

function getPackageMetadata() {
  return require('../../package.json');
}

function getCurrentPackageName() {
  return getPackageMetadata().name || NEW_PACKAGE_NAME;
}

/**
 * Get current package version
 * @returns {string}
 */
function getCurrentVersion() {
  return getPackageMetadata().version;
}

function isLegacyDistro(packageName = getCurrentPackageName()) {
  return packageName === LEGACY_PACKAGE_NAME;
}

function printLegacyDistroNotice(packageName = getCurrentPackageName()) {
  if (!isLegacyDistro(packageName)) {
    return false;
  }

  console.error(
    `\n⚠️  ${LEGACY_PACKAGE_NAME} has moved to ${NEW_PACKAGE_NAME}. ` +
      'Run `zeroshot update` to switch this installation.\n'
  );
  return true;
}

function getPackageRoot() {
  return path.dirname(require.resolve('../../package.json'));
}

function hasPathSuffix(parts, suffix) {
  if (suffix.length > parts.length) {
    return false;
  }

  const start = parts.length - suffix.length;
  return suffix.every((part, index) => parts[start + index] === part);
}

function joinPathParts(parts) {
  const joined = parts.join(path.sep);
  return joined === '' ? path.parse(process.cwd()).root : joined;
}

function deriveInstallPrefixFromPackageRoot(packageRoot, packageName) {
  const parts = path.resolve(packageRoot).split(path.sep);
  const packageParts = packageName.split('/');

  if (!hasPathSuffix(parts, packageParts)) {
    return null;
  }

  const nodeModulesIndex = parts.length - packageParts.length - 1;
  if (nodeModulesIndex < 0 || parts[nodeModulesIndex] !== 'node_modules') {
    return null;
  }

  if (parts[nodeModulesIndex - 1] === 'lib') {
    return joinPathParts(parts.slice(0, nodeModulesIndex - 1));
  }

  return joinPathParts(parts.slice(0, nodeModulesIndex));
}

function resolveNpmCommand(installPrefix = null) {
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const candidates = [];

  if (installPrefix) {
    candidates.push(path.join(installPrefix, 'bin', npmName));
  }

  candidates.push(path.join(path.dirname(process.execPath), npmName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return npmName;
}

function getNpmConfiguredPrefix(npmCommand = resolveNpmCommand()) {
  return childProcess
    .execFileSync(npmCommand, ['config', 'get', 'prefix'], {
      encoding: 'utf8',
    })
    .trim();
}

function getInstallPrefix(options = {}) {
  if (options.installPrefix) {
    return options.installPrefix;
  }

  const packageName = options.packageName || getCurrentPackageName();
  const packageRoot = options.packageRoot || getPackageRoot();
  const derivedPrefix = deriveInstallPrefixFromPackageRoot(packageRoot, packageName);

  if (derivedPrefix) {
    return derivedPrefix;
  }

  return getNpmConfiguredPrefix(options.npmCommand);
}

function getGlobalModulesDir(installPrefix) {
  const unixGlobalModulesDir = path.join(installPrefix, 'lib', 'node_modules');
  if (fs.existsSync(unixGlobalModulesDir)) {
    return unixGlobalModulesDir;
  }

  return path.join(installPrefix, 'node_modules');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildManualInstallCommand(installPrefix = null, useSudo = false) {
  const command = [
    useSudo ? 'sudo' : null,
    'npm',
    'install',
    '-g',
    installPrefix ? '--prefix' : null,
    installPrefix ? shellQuote(installPrefix) : null,
    NEW_PACKAGE_SPEC,
  ].filter(Boolean);

  return command.join(' ');
}

function getUpdateTarget(options = {}) {
  const packageName = options.packageName || getCurrentPackageName();
  const legacy = isLegacyDistro(packageName);
  const installPrefix = getInstallPrefix(options);
  const npmCommand = options.npmCommand || resolveNpmCommand(installPrefix);

  return {
    packageName,
    legacy,
    installPrefix,
    npmCommand,
    globalModulesDir: getGlobalModulesDir(installPrefix),
  };
}

function buildInstallArgs(updateTarget) {
  const args = ['install', '-g', '--prefix', updateTarget.installPrefix];

  if (updateTarget.legacy) {
    // npm refuses to replace the legacy package's `zeroshot` bin without this.
    args.push('--force');
  }

  args.push(NEW_PACKAGE_SPEC);
  return args;
}

function parseStableVersion(version) {
  if (typeof version !== 'string') return null;
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare validated stable semver versions.
 * @param {string} current
 * @param {string} latest
 * @returns {boolean}
 */
function isNewerVersion(current, latest) {
  const currentParts = parseStableVersion(current);
  const latestParts = parseStableVersion(latest);
  if (!currentParts || !latestParts) return false;

  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }
  return false;
}

function validatedManifestVersion(manifest) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.name !== NEW_PACKAGE_NAME ||
    !parseStableVersion(manifest.version) ||
    !manifest.dist ||
    typeof manifest.dist !== 'object' ||
    typeof manifest.dist.tarball !== 'string' ||
    !manifest.dist.tarball.trim().startsWith('https://') ||
    typeof manifest.dist.integrity !== 'string' ||
    manifest.dist.integrity.trim().length === 0
  ) {
    return null;
  }
  return manifest.version;
}

/**
 * Fetch and validate the installable npm latest manifest.
 * @param {object} options
 * @returns {Promise<string|null>}
 */
function fetchLatestVersion(options = {}) {
  const httpsModule = options.httpsModule || https;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    let request;
    let safetyTimer;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (safetyTimer) cancelTimeout(safetyTimer);
      request?.setTimeout?.(0);
      resolve(value);
    };

    try {
      request = httpsModule.get(REGISTRY_URL, { timeout: timeoutMs }, (response) => {
        if (response.statusCode !== 200) {
          response.destroy?.();
          request.destroy?.();
          finish(null);
          return;
        }

        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > maxResponseBytes) {
            response.destroy?.();
            request.destroy?.();
            finish(null);
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', () => finish(null));
        response.on('end', () => {
          if (settled) return;
          try {
            const manifest = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
            finish(validatedManifestVersion(manifest));
          } catch {
            finish(null);
          }
        });
      });
    } catch {
      finish(null);
      return;
    }

    request.on('error', () => finish(null));
    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    if (options.unref) {
      request.on('socket', (socket) => socket.unref?.());
    }

    safetyTimer = scheduleTimeout(() => {
      request.destroy();
      finish(null);
    }, timeoutMs + 1000);
    safetyTimer.unref?.();
  });
}


/**
 * Check if we have write permission to npm global directory
 * @returns {boolean} True if we can write to npm global prefix
 */
function canWriteToNpmGlobal(options = {}) {
  try {
    const updateTarget = getUpdateTarget(options);
    fs.accessSync(updateTarget.globalModulesDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run npm install to update the package
 * @returns {Promise<boolean>} True if update succeeded
 */
function runUpdate(options = {}) {
  return new Promise((resolve) => {
    let updateTarget;
    try {
      updateTarget = getUpdateTarget(options);
    } catch {
      console.log('❌ Update failed. Try manually:');
      console.log(`   ${buildManualInstallCommand()}\n`);
      resolve(false);
      return;
    }

    // Check permissions BEFORE attempting update
    if (!canWriteToNpmGlobal(options)) {
      console.log('\n⚠️  Cannot auto-update: no write permission to npm global directory.');
      console.log('   Run manually with sudo:');
      console.log(`   ${buildManualInstallCommand(updateTarget.installPrefix, true)}\n`);
      resolve(false);
      return;
    }

    console.log('\n📥 Installing update...');

    const proc = childProcess.spawn(updateTarget.npmCommand, buildInstallArgs(updateTarget), {
      stdio: 'inherit',
      shell: false,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Update installed successfully!');
        console.log('   Restart zeroshot to use the new version.\n');
        resolve(true);
      } else {
        console.log('❌ Update failed. Try manually:');
        console.log(`   ${buildManualInstallCommand(updateTarget.installPrefix, true)}\n`);
        resolve(false);
      }
    });

    proc.on('error', () => {
      console.log('❌ Update failed. Try manually:');
      console.log(`   ${buildManualInstallCommand(updateTarget.installPrefix, true)}\n`);
      resolve(false);
    });
  });
}

function optionIndex(argv, longName, shortName = null) {
  const end = argv.indexOf('--');
  const limit = end === -1 ? argv.length : end;
  for (let index = 0; index < limit; index += 1) {
    const token = argv[index];
    if (token === longName || (shortName && token === shortName)) return index;
    if (token.startsWith(`${longName}=`)) return index;
  }
  return -1;
}

function optionValue(argv, longName) {
  const index = optionIndex(argv, longName);
  if (index === -1) return null;
  const token = argv[index];
  if (token.startsWith(`${longName}=`)) return token.slice(longName.length + 1);
  return argv[index + 1] ?? null;
}

function commandPath(argv) {
  const positional = [];
  const optionsWithValues = new Set([
    '--format',
    '--output-format',
    '--json-schema',
    '--mcp-config',
  ]);
  const end = argv.indexOf('--');
  const limit = end === -1 ? argv.length : end;

  for (let index = 0; index < limit; index += 1) {
    const token = argv[index];
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) positional.push(token);
  }
  return positional;
}

/**
 * Pure classification for optional automatic update work.
 */
function isAutomaticUpdateEligible(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const currentVersion = options.currentVersion || getCurrentVersion();
  const packageName = options.packageName || getCurrentPackageName();

  if (
    packageName !== NEW_PACKAGE_NAME ||
    !parseStableVersion(currentVersion) ||
    argv.length === 0 ||
    stdin.isTTY !== true ||
    stdout.isTTY !== true ||
    stderr.isTTY !== true ||
    (env.CI !== undefined && env.CI !== null && String(env.CI).length > 0) ||
    env.ZEROSHOT_DAEMON === '1'
  ) {
    return false;
  }

  if (
    optionIndex(argv, '--quiet', '-q') !== -1 ||
    optionIndex(argv, '--help', '-h') !== -1 ||
    optionIndex(argv, '--version', '-V') !== -1 ||
    optionIndex(argv, '--completion') !== -1
  ) {
    return false;
  }

  const [command, subcommand] = commandPath(argv);
  if (!command) return false;
  if (
    command === 'update' ||
    command === 'get-log-path' ||
    (command === 'task' && subcommand === 'run') ||
    (command === 'setup' && ['plan', 'apply', 'undo'].includes(subcommand)) ||
    (command === 'cmdproof' && ['prove', 'verify', 'check'].includes(subcommand))
  ) {
    return false;
  }

  if (
    optionIndex(argv, '--json') !== -1 ||
    optionIndex(argv, '--silent-json-output') !== -1 ||
    optionIndex(argv, '--json-schema') !== -1
  ) {
    return false;
  }

  const outputFormat = optionValue(argv, '--output-format');
  if (outputFormat === 'json' || outputFormat === 'stream-json') return false;
  if (command === 'export' && optionValue(argv, '--format') === 'json') return false;

  return true;
}

function shouldCheckForUpdates(settings, now = Date.now()) {
  if (settings.autoCheckUpdates !== true) return false;
  const timestamp = settings.lastUpdateCheckAt;
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) return true;
  return now - timestamp >= CHECK_INTERVAL_MS;
}

async function refreshUpdateCache(options) {
  const now = options.now || Date.now;
  const transaction = options.mutateSettings || mutateSettings;
  const fetcher = options.fetchLatestVersion || fetchLatestVersion;
  const generateClaimId = options.generateClaimId || (() => crypto.randomUUID());
  const attemptAt = now();
  const claimId = generateClaimId();
  let claim;

  try {
    claim = transaction(
      (settings) => {
        if (!shouldCheckForUpdates(settings, attemptAt)) return null;
        settings.lastUpdateCheckAt = attemptAt;
        settings.lastUpdateCheckClaim = claimId;
        return { attemptAt, claimId };
      },
      { lockTimeoutMs: 0 }
    );
  } catch {
    return;
  }
  if (!claim) return;

  let latestVersion;
  try {
    latestVersion = await fetcher({ unref: true });
  } catch {
    return;
  }
  if (!parseStableVersion(latestVersion)) return;

  try {
    transaction(
      (settings) => {
        if (
          settings.autoCheckUpdates !== true ||
          settings.lastUpdateCheckAt !== attemptAt ||
          settings.lastUpdateCheckClaim !== claimId
        ) {
          return false;
        }
        settings.lastSeenVersion = latestVersion;
        settings.lastUpdateCheckClaim = null;
        return true;
      },
      { lockTimeoutMs: 0 }
    );
  } catch {
    // Optional cache persistence must never affect command dispatch or output.
  }
}

/**
 * Synchronously render the startup cache and begin a due refresh without awaiting it.
 * @returns {Promise<void>|null} the shared refresh, exposed for deterministic tests
 */
function checkForUpdates(options = {}) {
  if (!options.eligibilityChecked && !isAutomaticUpdateEligible(options)) return null;

  const currentVersion = options.currentVersion || getCurrentVersion();
  if (!parseStableVersion(currentVersion)) return null;
  const readSettings = options.loadSettings || loadSettings;
  let settings;
  try {
    settings = readSettings({ silent: true });
  } catch {
    return null;
  }
  if (settings.autoCheckUpdates !== true) return null;

  if (
    parseStableVersion(settings.lastSeenVersion) &&
    isNewerVersion(currentVersion, settings.lastSeenVersion)
  ) {
    try {
      const stderr = options.stderr || process.stderr;
      stderr.write(
        `Update available: ${currentVersion} → ${settings.lastSeenVersion}. Run \`zeroshot update\`.\n`
      );
    } catch {
      // Optional notification output failures are contained.
    }
  }

  const now = options.now || Date.now;
  if (!shouldCheckForUpdates(settings, now())) return null;
  if (inFlightRefresh) return inFlightRefresh;

  const refresh = new Promise((resolve) => {
    const schedule = options.scheduleRefresh || setImmediate;
    const handle = schedule(() => {
      Promise.resolve(refreshUpdateCache(options))
        .catch(() => {})
        .then(resolve);
    });
    handle?.unref?.();
  });
  inFlightRefresh = refresh;
  refresh.then(() => {
    if (inFlightRefresh === refresh) inFlightRefresh = null;
  });
  return refresh;
}

module.exports = {
  checkForUpdates,
  isAutomaticUpdateEligible,
  parseStableVersion,
  validatedManifestVersion,
  // Exported for testing and CLI update command
  NEW_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
  getCurrentVersion,
  getCurrentPackageName,
  isLegacyDistro,
  printLegacyDistroNotice,
  deriveInstallPrefixFromPackageRoot,
  getInstallPrefix,
  resolveNpmCommand,
  getUpdateTarget,
  buildInstallArgs,
  isNewerVersion,
  fetchLatestVersion,
  runUpdate,
  shouldCheckForUpdates,
  canWriteToNpmGlobal,
  CHECK_INTERVAL_MS,
  MAX_RESPONSE_BYTES,
};
