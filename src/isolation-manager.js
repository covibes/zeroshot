/**
 * IsolationManager - Docker container lifecycle for isolated cluster execution
 *
 * Handles:
 * - Container creation with workspace mounts
 * - Credential injection for provider CLIs
 * - Command execution inside containers
 * - Container cleanup on stop/kill
 */

const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { loadSettings } = require('../lib/settings');
const { resolveClaudeAuth } = require('../lib/settings/claude-auth');
const {
  normalizeProviderName,
  getProviderMetadata,
  getDefaultProviderId,
} = require('../lib/provider-names');
const {
  MOUNT_PRESETS,
  ENV_PRESETS,
  resolveMounts,
  resolveEnvs,
  expandEnvPatterns,
  isUsableEnvValue,
  validateProviderEnvAuth,
} = require('../lib/docker-config');
const { resolveProviderCredentialPaths } = require('../lib/provider-credential-path');
const { getProvider } = require('./providers');
const { readRepoSettings } = require('../lib/repo-settings');
const { provisionClaudeCredentials } = require('./claude-credentials');
const {
  CopyContainmentError,
  createCopyBoundary,
  resolveCopyPath,
  resolveSourcePath,
} = require('./copy-containment');

const DEFAULT_WORKTREE_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const FRESH_BASE_REF_PREFIX = 'refs/zeroshot/base-fetch';
const DETACHED_SETUP_CLUSTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DETACHED_SETUP_RESOURCE_KEYS = ['configDir', 'containerName', 'isolatedDir', 'kind'];

function getDetachedSetupResources(clusterId) {
  if (typeof clusterId !== 'string' || !DETACHED_SETUP_CLUSTER_ID_PATTERN.test(clusterId)) {
    throw new Error(`Invalid detached setup cluster ID: ${clusterId}`);
  }

  return Object.freeze({
    kind: 'docker',
    containerName: `zeroshot-cluster-${clusterId}`,
    isolatedDir: path.join(os.tmpdir(), 'zeroshot-isolated', clusterId),
    configDir: path.join(os.tmpdir(), 'zeroshot-cluster-configs', clusterId),
  });
}

function setupResourcesMatch(recorded, expected) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
  const keys = Object.keys(recorded).sort();
  return (
    keys.length === DETACHED_SETUP_RESOURCE_KEYS.length &&
    keys.every((key, index) => key === DETACHED_SETUP_RESOURCE_KEYS[index]) &&
    keys.every((key) => recorded[key] === expected[key])
  );
}

function removeBoundedSetupDirectory(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (path.dirname(resolvedTarget) !== resolvedRoot) {
    throw new Error(`Refusing to remove setup directory outside ${resolvedRoot}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function runSync(command, args, options = {}) {
  const timeout = options.timeout ?? 30000;
  const result = spawnSync(command, args, { ...options, timeout });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr?.toString() || 'no stderr';
    const error = new Error(
      `Command ${command} failed with status ${result.status ?? 'null'}: ${detail}`
    );
    error.status = result.status;
    error.stderr = result.stderr?.toString();
    throw error;
  }
  return result.stdout?.toString() || '';
}

function runShellSync(command, options = {}) {
  return runSync('/bin/bash', ['-lc', command], options);
}

function resolveCommit(repoRoot, ref) {
  return runSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function deleteTemporaryBaseRef(repoRoot, temporaryRef) {
  try {
    runSync('git', ['update-ref', '-d', temporaryRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    console.warn(
      `[IsolationManager] Warning: failed to remove temporary base ref ${temporaryRef}: ${err.message}`
    );
  }
}

function fetchFreshRemoteBase(repoRoot, remoteName, branch) {
  const temporaryRef = `${FRESH_BASE_REF_PREFIX}/${crypto.randomBytes(16).toString('hex')}`;

  try {
    runSync(
      'git',
      [
        'fetch',
        '--atomic',
        '--no-tags',
        '--no-write-fetch-head',
        '--refmap=',
        '--',
        remoteName,
        `+refs/heads/${branch}:${temporaryRef}`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );

    return {
      baseSha: resolveCommit(repoRoot, temporaryRef),
      temporaryRef,
    };
  } catch (err) {
    deleteTemporaryBaseRef(repoRoot, temporaryRef);
    throw err;
  }
}

function expandHomePath(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  return value.replace(/^~(?=\/|$)/, os.homedir());
}

function appendCredentialMount(plan, mount, explicitContainerPaths, claudeContainerPath) {
  if (mount.container === claudeContainerPath) {
    console.warn(
      `[IsolationManager] Skipping mount for ${mount.host} -> ${mount.container} ` +
        '(Claude config is managed by zeroshot).'
    );
    return;
  }

  const hostPath = expandHomePath(mount.host);
  let stat;
  try {
    stat = fs.statSync(hostPath);
  } catch {
    return;
  }
  if (hostPath.endsWith('config') && !stat.isFile()) return;

  plan.mountedHosts.push(hostPath);
  const mountSpec = mount.readonly
    ? `${hostPath}:${mount.container}:ro`
    : `${hostPath}:${mount.container}`;
  plan.args.push('-v', mountSpec);
  if (explicitContainerPaths.has(mount.container)) {
    plan.explicitMountContainerPaths.push(mount.container);
  }
}

function pathContains(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedBase === resolvedTarget) return true;
  return resolvedTarget.startsWith(resolvedBase + path.sep);
}

function parsePositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error(`${fieldName} must be a positive integer number of milliseconds`);
}

function resolveWorktreeSetupTimeoutMs(repoSettings = {}, options = {}) {
  const candidates = [
    { value: options.worktreeSetupTimeoutMs, field: 'options.worktreeSetupTimeoutMs' },
    { value: options.setupTimeoutMs, field: 'options.setupTimeoutMs' },
    {
      value: process.env.ZEROSHOT_WORKTREE_SETUP_TIMEOUT_MS,
      field: 'ZEROSHOT_WORKTREE_SETUP_TIMEOUT_MS',
    },
    { value: repoSettings.worktree?.setupTimeoutMs, field: 'worktree.setupTimeoutMs' },
  ];

  for (const candidate of candidates) {
    const parsed = parsePositiveInteger(candidate.value, candidate.field);
    if (parsed !== null) {
      return parsed;
    }
  }

  return DEFAULT_WORKTREE_SETUP_TIMEOUT_MS;
}

const DEFAULT_IMAGE = 'zeroshot-cluster-base';

/**
 * Shell command that installs a provider's CLI inside the cluster image, or null when the
 * provider is baked into the base image (e.g. Claude) or has no single-command installer.
 * Sourced from the provider registry (docker.install) so nothing here is provider-specific.
 * @param {string} providerName
 * @returns {string|null}
 */
function providerDockerInstall(providerName) {
  if (!providerName) return null;
  try {
    const metadata = getProviderMetadata(providerName);
    const install = metadata && metadata.docker && metadata.docker.install;
    return typeof install === 'string' && install.trim() ? install.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Registry-owned Docker platform (e.g. 'linux/amd64') for a provider, or null when unset.
 * Providers other than the ones that declare `docker.platform` keep today's host-native
 * (unset `--platform`) behavior.
 * @param {string} providerName
 * @returns {string|null}
 */
function providerDockerPlatform(providerName) {
  if (!providerName) return null;
  try {
    const metadata = getProviderMetadata(providerName);
    const platform = metadata && metadata.docker && metadata.docker.platform;
    return typeof platform === 'string' && platform.trim() ? platform.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Registry-owned $HOME-placeholder config/overlay roots for a provider, unexpanded.
 * @param {string} providerName
 * @returns {readonly string[]}
 */
function providerDockerConfigRootsRaw(providerName) {
  if (!providerName) return [];
  try {
    const metadata = getProviderMetadata(providerName);
    const roots = metadata && metadata.docker && metadata.docker.configRoots;
    return Array.isArray(roots) ? roots : [];
  } catch {
    return [];
  }
}

class IsolationManager {
  constructor(options = {}) {
    this.image = options.image || DEFAULT_IMAGE;
    this.containers = new Map(); // clusterId -> containerId
    this.isolatedDirs = new Map(); // clusterId -> { path, originalDir }
    this.clusterConfigDirs = new Map(); // clusterId -> configDirPath
    this.worktrees = new Map(); // clusterId -> { path, branch, repoRoot, baseRef, baseSha }
    this._exitWatchers = new Map(); // clusterId -> ChildProcess
  }

  /**
   * Get GitHub token from gh CLI config (hosts.yml)
   * Works with older gh CLI versions that don't have `gh auth token` command
   * @returns {string|null}
   * @private
   */
  _getGhToken() {
    try {
      const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
      if (!fs.existsSync(hostsPath)) return null;

      const content = fs.readFileSync(hostsPath, 'utf8');
      // Match oauth_token: <token> in YAML
      const match = content.match(/oauth_token:\s*(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Create and start a container for a cluster
   * @param {string} clusterId - Cluster ID
   * @param {object} config - Container config
   * @param {string} config.workDir - Working directory to mount
   * @param {string} [config.image] - Docker image (default: zeroshot-cluster-base)
   * @param {boolean} [config.reuseExistingWorkspace=false] - If true, reuse existing isolated workspace (for resume)
   * @param {Array<string|object>} [config.mounts] - Override default mounts (preset names or {host, container, readonly})
   * @param {boolean} [config.noMounts=false] - Disable all credential mounts
   * @param {string} [config.provider] - Provider name for credential warnings
   * @returns {Promise<string>} Container ID
   */
  async createContainer(clusterId, config) {
    const image = config.image || this.image;
    let workDir = config.workDir || process.cwd();
    const containerName = `zeroshot-cluster-${clusterId}`;
    const reuseExisting = config.reuseExistingWorkspace || false;

    const runningContainerId = this._getRunningContainerId(clusterId);
    if (runningContainerId) {
      return runningContainerId;
    }

    const settings = loadSettings();
    const providerName = normalizeProviderName(
      config.provider || settings.defaultProvider || getDefaultProviderId()
    );
    const containerHome = config.containerHome || settings.dockerContainerHome || '/root';

    // Pre-effect auth gate. The effective env/mount plan is computed (read-only) and validated
    // BEFORE the stale-container removal and the isolated-workspace copy, so a missing or
    // malformed credential plan leaves no container or workspace side effect behind — matching
    // the platform probe's ordering in orchestrator/agent-lifecycle/preflight.
    const credentialPlan = this._buildCredentialPlan(config, settings, containerHome, providerName);
    this._assertProviderCredentialPlan(providerName, {
      ...credentialPlan,
      config,
      containerHome,
    });

    this._removeContainerByName(containerName);

    workDir = await this._prepareIsolatedWorkspace(clusterId, workDir, reuseExisting);
    // The cluster config dir carries Claude credentials (via provisionClaudeCredentials) and the
    // Claude-specific AskUserQuestion-blocking hook (~/.claude/settings.json PreToolUse), which
    // only the `claude` CLI reads. Creating and mounting it for every provider — regardless of
    // whether Claude is even running in the container — was an unconditional Claude-auth side
    // channel into other providers' containers (e.g. omp, whose Docker isolation must be
    // env/broker-only with zero automatic mounts). Scope it to the claude provider only.
    const clusterConfigDir =
      providerName === 'claude' ? this._createClusterConfigDir(clusterId, containerHome) : null;
    if (clusterConfigDir) {
      console.log(`[IsolationManager] Created cluster config dir at ${clusterConfigDir}`);
    }

    const args = this._buildBaseDockerArgs({
      containerName,
      workDir,
      containerHome,
      clusterConfigDir,
      platform: config.platform,
    });

    args.push(...credentialPlan.args);
    args.push('-w', '/workspace', image, 'tail', '-f', '/dev/null');

    const containerId = await this._spawnContainer(clusterId, args, workDir);
    this._watchContainerExit(clusterId, containerId, config.onExit);
    return containerId;
  }

  _watchContainerExit(clusterId, containerId, onExit) {
    if (typeof onExit !== 'function') {
      return;
    }

    const existing = this._exitWatchers.get(clusterId);
    if (existing) {
      try {
        existing.kill('SIGKILL');
      } catch {
        // Ignore
      }
      this._exitWatchers.delete(clusterId);
    }

    const proc = spawn('docker', ['wait', containerId], { stdio: ['ignore', 'pipe', 'ignore'] });
    this._exitWatchers.set(clusterId, proc);

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    const finalize = () => {
      if (this._exitWatchers.get(clusterId) === proc) {
        this._exitWatchers.delete(clusterId);
      }
      const code = parseInt(stdout.trim(), 10);
      onExit({ clusterId, containerId, exitCode: Number.isFinite(code) ? code : null });
    };

    proc.on('close', finalize);
    proc.on('error', finalize);
  }

  _getRunningContainerId(clusterId) {
    const existingId = this.containers.get(clusterId);
    if (!existingId) {
      return null;
    }

    return this._isContainerRunning(existingId) ? existingId : null;
  }

  static getDetachedSetupResources(clusterId) {
    return getDetachedSetupResources(clusterId);
  }

  cleanupDetachedSetupResources(clusterId, recordedResources) {
    const expected = getDetachedSetupResources(clusterId);
    if (!setupResourcesMatch(recordedResources, expected)) {
      throw new Error(`Detached setup resources do not match cluster ${clusterId}`);
    }

    this._removeContainerByName(expected.containerName);
    removeBoundedSetupDirectory(path.join(os.tmpdir(), 'zeroshot-isolated'), expected.isolatedDir);
    removeBoundedSetupDirectory(
      path.join(os.tmpdir(), 'zeroshot-cluster-configs'),
      expected.configDir
    );
  }

  async _prepareIsolatedWorkspace(clusterId, workDir, reuseExisting) {
    if (!this._isGitRepo(workDir)) {
      return workDir;
    }

    this.isolatedDirs = this.isolatedDirs || new Map();
    const isolatedPath = path.join(os.tmpdir(), 'zeroshot-isolated', clusterId);

    if (reuseExisting && fs.existsSync(isolatedPath)) {
      console.log(`[IsolationManager] Reusing existing isolated workspace at ${isolatedPath}`);
      this.isolatedDirs.set(clusterId, {
        path: isolatedPath,
        originalDir: workDir,
      });
      return isolatedPath;
    }

    const isolatedDir = await this._createIsolatedCopy(clusterId, workDir);
    this.isolatedDirs.set(clusterId, {
      path: isolatedDir,
      originalDir: workDir,
    });
    console.log(`[IsolationManager] Created isolated copy at ${isolatedDir}`);
    return isolatedDir;
  }

  _buildBaseDockerArgs({ containerName, workDir, containerHome, clusterConfigDir, platform }) {
    const args = ['run', '-d', '--name', containerName];
    if (platform) {
      args.push('--platform', platform);
    }
    args.push(
      '-v',
      `${workDir}:/workspace`,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '--group-add',
      this._getDockerGid()
    );
    // Only mounted when the active provider is claude (see createContainer) — carries Claude
    // credentials and the Claude-specific AskUserQuestion-blocking hook, neither of which any
    // other provider's CLI reads.
    if (clusterConfigDir) {
      args.push('-v', `${clusterConfigDir}:${containerHome}/.claude`);
    }
    return args;
  }

  _resolveMountConfig(config, settings) {
    if (config.mounts) {
      return config.mounts;
    }

    if (process.env.ZEROSHOT_DOCKER_MOUNTS) {
      try {
        return JSON.parse(process.env.ZEROSHOT_DOCKER_MOUNTS);
      } catch {
        console.warn('[IsolationManager] Invalid ZEROSHOT_DOCKER_MOUNTS JSON, using settings');
        return settings.dockerMounts;
      }
    }

    return settings.dockerMounts;
  }

  // Auto-activate the running provider's own credential preset (mount and/or env) so `--docker`
  // works without listing it in dockerMounts. Env-only providers (e.g. omp) have no MOUNT_PRESETS
  // entry, so both preset maps are checked.
  _withActiveProviderPreset(mountConfig, providerName) {
    if (!providerName) return mountConfig;
    if (!MOUNT_PRESETS[providerName] && !ENV_PRESETS[providerName]) return mountConfig;
    if (mountConfig.some((item) => item === providerName)) return mountConfig;
    return [...mountConfig, providerName];
  }

  /**
   * Compute the *effective* credential plan for a container — the exact `-v`/`-e` argv the
   * container would receive, plus which of it the user explicitly opted into — WITHOUT applying
   * any side effect. Callers validate the plan (see `_assertProviderCredentialPlan`) before
   * touching containers or workspaces, then splice `plan.args` into the final argv.
   *
   * `forwardedEnv` holds the ACTUAL values the container would receive, so a forced-empty entry
   * (`dockerEnvPassthrough: ["OPENAI_API_KEY="]`) is distinguishable from a real key. Values stay
   * internal — they are never logged or included in any error message.
   *
   * @param {object} config
   * @param {object} settings
   * @param {string} containerHome
   * @param {string} providerName
   * @returns {{args: string[], mountedHosts: string[], explicitMountContainerPaths: string[],
   *   forwardedEnv: Record<string, string>, explicitEnvNames: Set<string>}}
   */
  _buildCredentialPlan(config, settings, containerHome, providerName) {
    const plan = {
      args: [],
      mountedHosts: [],
      explicitMountContainerPaths: [],
      forwardedEnv: {},
      explicitEnvNames: new Set(),
    };

    if (config.noMounts) {
      return plan;
    }

    // The user's own config, before the running provider's preset is auto-activated. Anything
    // sourced from here is an *explicit* opt-in; anything added by `_withActiveProviderPreset` is
    // automatic. Credential accounting depends on that distinction.
    const userMountConfig = this._resolveMountConfig(config, settings);
    const mountConfig = this._withActiveProviderPreset(userMountConfig, providerName);

    const mounts = resolveMounts(mountConfig, { containerHome });
    const explicitContainerPaths = new Set(
      resolveMounts(userMountConfig, { containerHome }).map((mount) => mount.container)
    );
    const claudeContainerPath = path.posix.join(containerHome, '.claude');

    for (const mount of mounts) {
      appendCredentialMount(plan, mount, explicitContainerPaths, claudeContainerPath);
    }

    const { envToPass, explicitNames } = this._collectDockerEnvVars(
      mountConfig,
      userMountConfig,
      settings
    );
    const hostOnlyEnvs = new Set(
      mountConfig
        .filter((preset) => typeof preset === 'string')
        .map((preset) => MOUNT_PRESETS[preset]?.hostEnv)
        .filter((name) => typeof name === 'string')
    );
    for (const hostOnlyEnv of hostOnlyEnvs) {
      delete envToPass[hostOnlyEnv];
      explicitNames.delete(hostOnlyEnv);
    }
    for (const [key, value] of Object.entries(envToPass)) {
      plan.args.push('-e', `${key}=${value}`);
      plan.forwardedEnv[key] = value;
    }
    plan.explicitEnvNames = explicitNames;

    return plan;
  }

  /**
   * Apply the credential plan to an argv array. Thin wrapper around `_buildCredentialPlan` kept
   * for callers that build argv incrementally.
   */
  _applyCredentialMounts(args, config, settings, containerHome, providerName) {
    const plan = this._buildCredentialPlan(config, settings, containerHome, providerName);
    args.push(...plan.args);
    return plan;
  }

  /**
   * @param {Array<string|object>} mountConfig - effective config (user's + auto provider preset)
   * @param {Array<string|object>} userMountConfig - the user's config only
   * @param {object} settings
   * @returns {{envToPass: Record<string, string>, explicitNames: Set<string>}}
   */
  _collectDockerEnvVars(mountConfig, userMountConfig, settings) {
    const envToPass = {};
    const envSpecs = expandEnvPatterns(resolveEnvs(mountConfig, settings.dockerEnvPassthrough));
    // Names the user opted into by name (dockerEnvPassthrough) or by explicitly listing a preset,
    // as opposed to the running provider's automatically-activated preset.
    const explicitSpecs = expandEnvPatterns(
      resolveEnvs(userMountConfig, settings.dockerEnvPassthrough)
    );
    const explicitNames = new Set(explicitSpecs.map((spec) => spec.name));

    for (const spec of envSpecs) {
      if (spec.forced) {
        envToPass[spec.name] = spec.value;
      } else if (process.env[spec.name]) {
        envToPass[spec.name] = process.env[spec.name];
      }
    }

    // Claude's own auth resolution only applies when Claude's preset is actually active (either
    // as the running provider or explicitly configured) — never as an unconditional side channel
    // into another provider's container (e.g. omp).
    if (mountConfig.includes('claude')) {
      const authEnv = resolveClaudeAuth(settings);
      for (const [key, value] of Object.entries(authEnv)) {
        if (!(key in envToPass)) {
          envToPass[key] = value;
        }
      }
    }

    return { envToPass, explicitNames };
  }

  /**
   * Decide whether the running provider has usable credentials in the *effective* container plan
   * (what would actually be mounted/forwarded, with actual values), not host presence. Providers
   * with no `docker.mount` (env-only, e.g. omp) fail closed — throw with remediation and never
   * fall back to another provider. All other providers keep today's non-fatal warning.
   *
   * A credential counts when ALL of the following hold:
   *  - it is a registry-known credential env key for this provider, AND
   *  - it is in the provider's automatic allowlist (`docker.envAuth.requireOneOf`) OR the user
   *    explicitly opted it in (dockerEnvPassthrough / an explicitly listed preset), AND
   *  - its forwarded value is non-empty/non-whitespace, AND
   *  - if that value is an absolute container path (a *path* credential), an explicitly
   *    configured mount actually provides that path inside the container.
   *
   * Hard plan defects (a partial required pair, a non-http(s) broker URL) are never compensated
   * for by another credential.
   *
   * Error/warning text names variables and paths from the *configuration*, never a forwarded
   * value.
   *
   * @param {string} providerName
   * @param {{mountedHosts: string[], explicitMountContainerPaths: string[],
   *   forwardedEnv: Record<string, string>, explicitEnvNames: Set<string>,
   *   config: object, containerHome: string}} plan
   */
  _assertProviderCredentialPlan(
    providerName,
    {
      mountedHosts,
      explicitMountContainerPaths = [],
      forwardedEnv,
      explicitEnvNames = new Set(),
      config,
      containerHome,
    }
  ) {
    if (providerName === 'claude') {
      return;
    }

    const metadata = getProviderMetadata(providerName);
    const provider = getProvider(providerName);
    const docker = metadata.docker || {};

    // Structural env/broker validation: required-pair completeness and URL shape.
    const envAuthResult = validateProviderEnvAuth(providerName, forwardedEnv);
    const { satisfying, notOptedIn, unmountedPath } = this._classifyForwardedCredentials(metadata, {
      forwardedEnv,
      explicitEnvNames,
      explicitMountContainerPaths,
    });

    // A mount only counts if it carries the secret (credentialInMount !== false).
    const credentialPaths = provider.getCredentialPaths ? provider.getCredentialPaths() : [];
    const expandedCreds = resolveProviderCredentialPaths({ ...metadata, credentialPaths }).filter(
      (credPath) => fs.existsSync(credPath)
    );
    const hasCredentialMount =
      docker.credentialInMount !== false &&
      mountedHosts.some((hostPath) =>
        expandedCreds.some(
          (credPath) => pathContains(hostPath, credPath) || pathContains(credPath, hostPath)
        )
      );

    if (envAuthResult.malformed.length === 0 && (satisfying.length > 0 || hasCredentialMount)) {
      return;
    }

    const reasons = [...envAuthResult.malformed];
    if (unmountedPath.length > 0) {
      reasons.push(
        `${unmountedPath.join(', ')} points at a container path that no explicit --mount provides`
      );
    }
    if (notOptedIn.length > 0) {
      reasons.push(
        `${notOptedIn.join(', ')} (known ${provider.displayName} credentials outside the ` +
          'automatic allowlist) were not explicitly opted in'
      );
    }
    if (reasons.length === 0) {
      reasons.push('no credential env var or mount found in the effective container plan');
    }

    const mountNote = config.noMounts ? 'Credential mounts are disabled. ' : '';
    const allowlist = docker.envPassthrough || [];
    const message =
      `${mountNote}No usable credentials found for ${provider.displayName} in the effective ` +
      `Docker env/mount plan (${reasons.join('; ')}). Automatic env allowlist: ` +
      `${allowlist.join(', ') || '(none)'}. ` +
      this._credentialRemediation(provider, docker, credentialPaths, containerHome);

    // Env-only providers (no automatic mount) have no fallback credential surface, so an
    // unsatisfied/malformed plan must fail closed before the container ever starts.
    if (!docker.mount) {
      throw new Error(`[IsolationManager] ${message}`);
    }

    console.warn(`[IsolationManager] ⚠️  ${message}`);
  }

  /**
   * Split this provider's registry-known credential env vars into the ones that actually
   * authenticate the container and the two ways they can fail to.
   *
   * @param {object} metadata - registry provider metadata
   * @param {{forwardedEnv: Record<string, string>, explicitEnvNames: Set<string>,
   *   explicitMountContainerPaths: string[]}} plan
   * @returns {{satisfying: string[], notOptedIn: string[], unmountedPath: string[]}}
   *   `notOptedIn`: a known credential carrying a real value that is neither on the automatic
   *   allowlist nor explicitly passed through. `unmountedPath`: a path credential whose container
   *   path no explicit mount provides — the file simply is not there.
   */
  _classifyForwardedCredentials(
    metadata,
    { forwardedEnv, explicitEnvNames, explicitMountContainerPaths }
  ) {
    const docker = metadata.docker || {};
    const envAuth = docker.envAuth;
    const automatic = new Set(envAuth ? envAuth.requireOneOf : []);
    const usable = (metadata.credentialEnvKeys || []).filter((key) =>
      isUsableEnvValue(forwardedEnv[key])
    );

    const satisfying = [];
    const notOptedIn = [];
    const unmountedPath = [];

    for (const name of usable) {
      // A registry-known credential outside the automatic allowlist is usable only when explicitly
      // opted in — that is the "custom env credential requires explicit passthrough" rule, not a
      // reason for it to stay permanently unusable.
      if (envAuth && !automatic.has(name) && !explicitEnvNames.has(name)) {
        notOptedIn.push(name);
        continue;
      }
      // A path credential (value is an absolute container path) is only real when an explicitly
      // configured mount actually provides that path. Host-side existence proves nothing about
      // what the container can read.
      const value = forwardedEnv[name];
      const isContainerPath = value.startsWith('/');
      if (
        isContainerPath &&
        !explicitMountContainerPaths.some((containerPath) => pathContains(containerPath, value))
      ) {
        unmountedPath.push(name);
        continue;
      }
      satisfying.push(name);
    }

    return { satisfying, notOptedIn, unmountedPath };
  }

  /**
   * Remediation sentence for a provider with no usable credential plan.
   *
   * Env-only providers (no `docker.mount`) must NEVER be told to mount their host auth store —
   * not mounting/copying it is the whole point of their Docker contract. They get the broker
   * pair (when the registry declares one) plus a generic custom-path example instead. Mount-based
   * providers keep the concrete "mount your credential dir" hint.
   *
   * @param {{displayName: string}} provider
   * @param {object} docker - registry docker metadata
   * @param {readonly string[]} credentialPaths
   * @param {string} containerHome
   * @returns {string}
   */
  _credentialRemediation(provider, docker, credentialPaths, containerHome) {
    const customEnvHint =
      `Any other credential needs explicit opt-in: ` +
      `zeroshot settings set dockerEnvPassthrough '["MY_KEY"]'`;
    const genericPathHint =
      `for a file credential also mount it and point the var at the container path: ` +
      `--mount /host/path/to/credential:${path.posix.join(containerHome, 'credential')}:ro ` +
      `with dockerEnvPassthrough '["MY_PATH_CREDENTIAL=${path.posix.join(containerHome, 'credential')}"]'`;

    if (!docker.mount) {
      const brokerPair =
        (docker.envAuth && docker.envAuth.requireTogether && docker.envAuth.requireTogether[0]) ||
        null;
      const brokerHint = brokerPair
        ? `Prefer the auth broker (${brokerPair.join(' + ')}) so host refresh tokens never cross. `
        : '';
      return (
        `Export one of the listed vars. ${brokerHint}${customEnvHint}, or ${genericPathHint}. ` +
        `${provider.displayName}'s host auth store is never mounted or copied into the container.`
      );
    }

    const exampleHost = credentialPaths[0];
    const mountHint = exampleHost
      ? ` or --mount ${exampleHost}:${exampleHost.replace(/^~(?=\/|$)/, containerHome)}:ro for a custom path credential`
      : '';
    return `Export one of the listed vars, or add a custom credential with ${customEnvHint}${mountHint}.`;
  }

  _spawnContainer(clusterId, args, workDir) {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data;
      });
      proc.stderr.on('data', (data) => {
        stderr += data;
      });

      proc.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to create container: ${stderr}`));
          return;
        }

        const containerId = stdout.trim().substring(0, 12);
        this.containers.set(clusterId, containerId);

        try {
          console.log(`[IsolationManager] Checking for package.json in ${workDir}...`);
          if (fs.existsSync(path.join(workDir, 'package.json'))) {
            await this._installDependenciesWithRetry(clusterId);
          }
        } catch (err) {
          console.warn(
            `[IsolationManager] ⚠️ Failed to install dependencies (non-fatal): ${err.message}`
          );
        }

        resolve(containerId);
      });

      proc.on('error', (err) => {
        reject(new Error(`Docker spawn error: ${err.message}`));
      });
    });
  }

  async _installDependenciesWithRetry(clusterId) {
    console.log(`[IsolationManager] Installing npm dependencies in container...`);

    const maxRetries = 3;
    const baseDelay = 2000; // 2 seconds
    const installCommand = [
      'sh',
      '-c',
      [
        'if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then',
        'echo "__deps_present__";',
        'exit 0;',
        'fi;',
        'if ! command -v npm >/dev/null 2>&1; then',
        'echo "__npm_missing__";',
        'exit 127;',
        'fi;',
        'if [ -d /pre-baked-deps/node_modules ]; then',
        'cp -rn /pre-baked-deps/node_modules . 2>/dev/null || true;',
        'npm_config_engine_strict=false npm install --no-audit --no-fund --prefer-offline;',
        'install_code=$?;',
        'if [ $install_code -ne 0 ]; then',
        'rm -rf node_modules;',
        'npm_config_engine_strict=false npm install --no-audit --no-fund;',
        'fi;',
        'else',
        'npm_config_engine_strict=false npm install --no-audit --no-fund;',
        'fi',
      ].join(' '),
    ];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const installResult = await this.execInContainer(clusterId, installCommand, {});
        const stdout = installResult.stdout || '';

        if (installResult.code === 0) {
          if (stdout.includes('__deps_present__')) {
            console.log(
              `[IsolationManager] ✓ Dependencies already installed (skipping npm install)`
            );
          } else {
            console.log(`[IsolationManager] ✓ Dependencies installed`);
          }
          return;
        }

        const errorOutput = (installResult.stderr || installResult.stdout || '').slice(0, 500);
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(
            `[IsolationManager] ⚠️ npm install failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
          );
          console.warn(`[IsolationManager] Error: ${errorOutput}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.warn(
            `[IsolationManager] ⚠️ npm install failed after ${maxRetries} attempts (non-fatal): ${errorOutput}`
          );
        }
      } catch (execErr) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(
            `[IsolationManager] ⚠️ npm install execution error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
          );
          console.warn(`[IsolationManager] Error: ${execErr.message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw execErr;
        }
      }
    }
  }

  /**
   * Execute a command inside the container
   * @param {string} clusterId - Cluster ID
   * @param {string[]} command - Command and arguments
   * @param {object} [options] - Exec options
   * @param {boolean} [options.interactive] - Use -it flags
   * @param {object} [options.env] - Environment variables
   * @param {number} [options.timeout=30000] - Timeout in ms (0 = no timeout). Prevents infinite hangs.
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  execInContainer(clusterId, command, options = {}) {
    const containerId = this.containers.get(clusterId);
    if (!containerId) {
      throw new Error(`No container found for cluster ${clusterId}`);
    }

    const args = ['exec'];

    if (options.interactive) {
      args.push('-it');
    }

    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(containerId, ...command);

    // Default timeout: 30 seconds (prevents infinite hangs)
    const timeout = options.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const proc = spawn('docker', args, {
        stdio: options.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutId = null;

      // Set up timeout if specified (0 = no timeout)
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, timeout);
      }

      if (!options.interactive) {
        proc.stdout.on('data', (data) => {
          stdout += data;
        });
        proc.stderr.on('data', (data) => {
          stderr += data;
        });
      }

      proc.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (timedOut) {
          reject(new Error(`Docker exec timed out after ${timeout}ms`));
        } else {
          resolve({ stdout, stderr, code });
        }
      });

      proc.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(new Error(`Docker exec error: ${err.message}`));
      });
    });
  }

  async getContainerEnvironmentValue(clusterId, name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid container environment variable name: ${name}`);
    }
    const result = await this.execInContainer(clusterId, ['printenv', name]);
    if (result.code === 1) return null;
    if (result.code !== 0) {
      throw new Error(
        `Failed to read container environment variable ${name}: ${
          result.stderr || `exit ${result.code}`
        }`
      );
    }
    return result.stdout.replace(/\r?\n$/, '');
  }

  /**
   * Spawn a PTY-like process inside the container
   * Returns a child process that can be used like a PTY
   * @param {string} clusterId - Cluster ID
   * @param {string[]} command - Command and arguments
   * @param {object} [options] - Spawn options
   * @returns {ChildProcess}
   */
  spawnInContainer(clusterId, command, options = {}) {
    const containerId = this.containers.get(clusterId);
    if (!containerId) {
      throw new Error(`No container found for cluster ${clusterId}`);
    }

    // IMPORTANT: Must use -i flag for interactive stdin/stdout communication with commands like 'cat'
    // If omitted, docker exec will not properly connect stdin, causing piped input to be ignored
    // This is required for PTY-like behavior where child process stdin/stdout are used
    const args = ['exec', '-i'];

    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(containerId, ...command);

    // spawn() throws on null bytes in argv; strip them before they get there.
    const safeArgs = args.map((arg) => (typeof arg === 'string' ? arg.replace(/\0/g, '') : arg));

    return spawn('docker', safeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options.spawnOptions,
    });
  }

  /**
   * Stop a container
   * @param {string} clusterId - Cluster ID
   * @param {number} [timeout=10] - Timeout in seconds before SIGKILL
   * @returns {Promise<void>}
   */
  stopContainer(clusterId, timeout = 10, explicitContainerId = null) {
    // Use explicit containerId (from restored state) or in-memory Map
    const containerId = explicitContainerId || this.containers.get(clusterId);
    if (!containerId) {
      return; // Already stopped or never started
    }

    return new Promise((resolve) => {
      const proc = spawn('docker', ['stop', '-t', String(timeout), containerId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.on('close', () => {
        resolve();
      });

      proc.on('error', () => {
        resolve(); // Ignore errors on stop
      });
    });
  }

  /**
   * Remove a container
   * @param {string} clusterId - Cluster ID
   * @param {boolean} [force=false] - Force remove running container
   * @returns {Promise<void>}
   */
  removeContainer(clusterId, force = false, explicitContainerId = null) {
    // Use explicit containerId (from restored state) or in-memory Map
    const containerId = explicitContainerId || this.containers.get(clusterId);
    if (!containerId) {
      return;
    }

    const args = ['rm'];
    if (force) {
      args.push('-f');
    }
    args.push(containerId);

    return new Promise((resolve) => {
      const proc = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.on('close', () => {
        this.containers.delete(clusterId);
        resolve();
      });

      proc.on('error', () => {
        this.containers.delete(clusterId);
        resolve();
      });
    });
  }

  /**
   * Stop and remove a container, and optionally clean up isolated dir/config
   * @param {string} clusterId - Cluster ID
   * @param {object} [options] - Cleanup options
   * @param {boolean} [options.preserveWorkspace=false] - If true, keep the isolated workspace (for resume capability)
   * @returns {Promise<void>}
   */
  async cleanup(clusterId, options = {}) {
    const preserveWorkspace = options.preserveWorkspace || false;

    await this.stopContainer(clusterId);
    await this.removeContainer(clusterId);

    // Clean up isolated directory if one was created (unless preserveWorkspace is set)
    if (this.isolatedDirs?.has(clusterId)) {
      const isolatedInfo = this.isolatedDirs.get(clusterId);

      if (preserveWorkspace) {
        console.log(
          `[IsolationManager] Preserving isolated workspace at ${isolatedInfo.path} for resume`
        );
        // Don't delete - but DON'T remove from Map either, resume() needs it
      } else {
        console.log(`[IsolationManager] Cleaning up isolated dir at ${isolatedInfo.path}`);

        // Preserve Terraform state before deleting isolated directory
        this._preserveTerraformState(clusterId, isolatedInfo.path);

        // Remove the isolated directory
        try {
          fs.rmSync(isolatedInfo.path, { recursive: true, force: true });
        } catch {
          // Ignore
        }
        this.isolatedDirs.delete(clusterId);
      }
    }

    // Clean up cluster config dir (always - it's recreated on resume)
    this._cleanupClusterConfigDir(clusterId);
  }

  /**
   * Create an isolated copy of a directory with fresh git repo
   * @private
   * @param {string} clusterId - Cluster ID
   * @param {string} sourceDir - Source directory to copy
   * @returns {Promise<string>} Path to isolated directory
   */
  async _createIsolatedCopy(clusterId, sourceDir) {
    const isolatedPath = path.join(os.tmpdir(), 'zeroshot-isolated', clusterId);

    // Clean up existing dir
    if (fs.existsSync(isolatedPath)) {
      fs.rmSync(isolatedPath, { recursive: true, force: true });
    }

    // Create directory
    fs.mkdirSync(isolatedPath, { recursive: true });

    // Copy files (excluding .git and common build artifacts)
    await this._copyDirExcluding(sourceDir, isolatedPath, [
      '.git',
      'node_modules',
      '.next',
      'dist',
      'build',
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
      '.venv',
      'venv',
      '.tox',
      '.eggs',
      '*.egg-info',
      'coverage',
      '.coverage',
      '.nyc_output',
      '.DS_Store',
      'Thumbs.db',
    ]);

    // Get remote URL from original repo (for PR creation)
    let remoteUrl = null;
    try {
      remoteUrl = runSync('git', ['remote', 'get-url', 'origin'], {
        cwd: sourceDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    } catch {
      // No remote configured in source
    }

    // Initialize fresh git repo with all setup in a single batched command
    // This reduces ~500ms overhead (5 execSync calls @ ~100ms each) to ~100ms (1 call)
    // Issue #22: Batch git operations for 5-10% startup reduction
    const branchName = `zeroshot/${clusterId}`;

    // Build authenticated remote URL if source had one (needed for git push / PR creation)
    let authRemoteUrl = null;
    if (remoteUrl) {
      authRemoteUrl = remoteUrl;
      const token = this._getGhToken();
      if (token && remoteUrl.startsWith('https://github.com/')) {
        // Convert https://github.com/org/repo.git to https://x-access-token:TOKEN@github.com/org/repo.git
        authRemoteUrl = remoteUrl.replace(
          'https://github.com/',
          `https://x-access-token:${token}@github.com/`
        );
      }
    }

    runSync('git', ['init'], { cwd: isolatedPath, stdio: 'pipe' });
    if (authRemoteUrl) {
      runSync('git', ['remote', 'add', 'origin', authRemoteUrl], {
        cwd: isolatedPath,
        stdio: 'pipe',
      });
    }
    runSync('git', ['add', '-A'], { cwd: isolatedPath, stdio: 'pipe' });
    runSync('git', ['commit', '-m', 'Initial commit (isolated copy)', '--allow-empty'], {
      cwd: isolatedPath,
      stdio: 'pipe',
    });
    runSync('git', ['checkout', '-b', branchName], { cwd: isolatedPath, stdio: 'pipe' });

    return isolatedPath;
  }

  /**
   * Copy directory excluding certain paths using parallel worker threads
   * Supports exact matches and glob patterns (*.ext)
   *
   * Performance optimization for large repos (10k+ files):
   * - Phase 1: Collect all files async (non-blocking traversal)
   * - Phase 2: Create directory structure (must be sequential)
   * - Phase 3: Copy files in parallel using worker threads
   *
   * @private
   * @param {string} src - Source directory
   * @param {string} dest - Destination directory
   * @param {string[]} exclude - Patterns to exclude
   * @returns {Promise<void>}
   */
  async _copyDirExcluding(src, dest, exclude) {
    // Phase 1: Collect all files and directories
    const files = [];
    const directories = new Set();
    const copyBoundary = createCopyBoundary(src, dest);

    const shouldIgnoreFsError = (err) =>
      err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOENT';

    const shouldExcludeEntry = (entryName) => {
      return exclude.some((pattern) => {
        if (pattern.startsWith('*.')) {
          return entryName.endsWith(pattern.slice(1));
        }
        return entryName === pattern;
      });
    };

    const ensureParentDirTracked = (relativePath) => {
      if (relativePath) {
        directories.add(relativePath);
      }
    };

    const readEntries = (currentSrc) => {
      try {
        return fs.readdirSync(currentSrc, { withFileTypes: true });
      } catch (err) {
        if (shouldIgnoreFsError(err)) {
          return [];
        }
        throw err;
      }
    };

    function handleEntry(entry, srcPath, relPath, relativePath, ancestorDirectories) {
      if (entry.isSymbolicLink()) {
        const targetStats = fs.statSync(srcPath);
        if (targetStats.isDirectory()) {
          const resolvedSourcePath = resolveSourcePath(copyBoundary, relPath);
          if (ancestorDirectories.has(resolvedSourcePath)) {
            throw new CopyContainmentError(relPath, 'source directory symlink creates a cycle');
          }
          directories.add(relPath);
          collectFiles(relPath, ancestorDirectories);
          return;
        }

        files.push(relPath);
        ensureParentDirTracked(relativePath);
        return;
      }

      if (entry.isDirectory()) {
        directories.add(relPath);
        collectFiles(relPath, ancestorDirectories);
        return;
      }

      files.push(relPath);
      ensureParentDirTracked(relativePath);
    }

    function collectFiles(relativePath = '', ancestorDirectories = new Set()) {
      const currentSrc = relativePath
        ? resolveSourcePath(copyBoundary, relativePath)
        : copyBoundary.sourceRoot.canonicalPath;
      if (ancestorDirectories.has(currentSrc)) {
        throw new CopyContainmentError(relativePath, 'source directory symlink creates a cycle');
      }
      const childAncestors = new Set(ancestorDirectories);
      childAncestors.add(currentSrc);
      const entries = readEntries(currentSrc);

      for (const entry of entries) {
        if (shouldExcludeEntry(entry.name)) {
          continue;
        }

        const srcPath = path.join(currentSrc, entry.name);
        const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

        try {
          handleEntry(entry, srcPath, relPath, relativePath, childAncestors);
        } catch (err) {
          if (shouldIgnoreFsError(err)) {
            continue;
          }
          throw err;
        }
      }
    }

    collectFiles();

    // Phase 2: Create directory structure (sequential - must exist before file copy)
    // Sort directories by depth to ensure parents are created before children
    const sortedDirs = Array.from(directories).sort((a, b) => {
      const depthA = a.split(path.sep).length;
      const depthB = b.split(path.sep).length;
      return depthA - depthB;
    });

    for (const dir of sortedDirs) {
      const { destinationPath: destDir } = resolveCopyPath(copyBoundary, dir);
      try {
        fs.mkdirSync(destDir, { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw err;
        }
      }
    }

    // Phase 3: Copy files in parallel using worker threads
    // For small file counts (<100), use synchronous copy (worker overhead not worth it)
    if (files.length < 100) {
      for (const relPath of files) {
        try {
          const { sourcePath, destinationPath } = resolveCopyPath(copyBoundary, relPath);
          fs.copyFileSync(sourcePath, destinationPath);
        } catch (err) {
          if (err.code !== 'EACCES' && err.code !== 'EPERM' && err.code !== 'ENOENT') {
            throw err;
          }
        }
      }
      return;
    }

    // Use worker threads for larger file counts
    const numWorkers = Math.min(4, os.cpus().length);
    const chunkSize = Math.ceil(files.length / numWorkers);
    const workerPath = path.join(__dirname, 'copy-worker.js');

    // Split files into chunks for workers
    const chunks = [];
    for (let i = 0; i < files.length; i += chunkSize) {
      chunks.push(files.slice(i, i + chunkSize));
    }

    // Spawn workers and wait for completion
    const workerPromises = chunks.map((chunk) => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            files: chunk,
            sourceBase: copyBoundary.sourceRoot.canonicalPath,
            destBase: copyBoundary.destinationRoot.canonicalPath,
            expectedBoundary: copyBoundary,
          },
        });

        worker.on('message', (result) => {
          resolve(result);
        });

        worker.on('error', (err) => {
          reject(err);
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}`));
          }
        });
      });
    });

    // Wait for all workers to complete (proper async/await - no busy-wait!)
    // FIX: Previous version used busy-wait which blocked the event loop,
    // preventing worker thread messages from being processed (timeout bug)
    const workerResults = await Promise.all(workerPromises);
    const failedResult = workerResults.find((result) => result.error);
    if (failedResult) {
      const error = new Error(failedResult.error.message);
      error.name = failedResult.error.name || 'Error';
      if (failedResult.error.code) {
        error.code = failedResult.error.code;
      }
      throw error;
    }
  }

  /**
   * Get container ID for a cluster
   * @param {string} clusterId - Cluster ID
   * @returns {string|undefined}
   */
  getContainerId(clusterId) {
    return this.containers.get(clusterId);
  }

  /**
   * Check if a cluster has an active container
   * @param {string} clusterId - Cluster ID
   * @returns {boolean}
   */
  hasContainer(clusterId) {
    const containerId = this.containers.get(clusterId);
    if (!containerId) return false;
    return this._isContainerRunning(containerId);
  }

  /**
   * Get Claude config directory
   * @private
   */
  _getClaudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  /**
   * Create a fresh Claude config directory for a cluster (avoids permission issues from host)
   * Copies only essential files: .credentials.json
   * @private
   * @param {string} clusterId - Cluster ID
   * @param {string} containerHome - Container home directory path (e.g., '/root' or '/home/node')
   * @returns {string} Path to cluster-specific config directory
   */
  _createClusterConfigDir(clusterId, containerHome = '/root') {
    const sourceDir = this._getClaudeConfigDir();
    const configDir = path.join(os.tmpdir(), 'zeroshot-cluster-configs', clusterId);

    // Clean up existing dir
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }

    // Create fresh directory and required subdirectories
    fs.mkdirSync(configDir, { recursive: true });
    const hooksDir = path.join(configDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // CRITICAL: Claude CLI writes session files to projects/ subdirectory
    const projectsDir = path.join(configDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    // Copy credentials file, or materialize from macOS Keychain if none exists
    // (essential for auth; see src/claude-credentials.js)
    provisionClaudeCredentials({ sourceDir, destDir: configDir });

    // Copy hook script to block AskUserQuestion (CRITICAL for autonomous execution)
    const hookScriptSrc = path.join(__dirname, '..', 'cluster-hooks', 'block-ask-user-question.py');
    const hookScriptDst = path.join(hooksDir, 'block-ask-user-question.py');
    if (fs.existsSync(hookScriptSrc)) {
      fs.copyFileSync(hookScriptSrc, hookScriptDst);
      fs.chmodSync(hookScriptDst, 0o755);
    }

    // Create settings.json with PreToolUse hook to block AskUserQuestion
    // This PREVENTS agents from asking questions in non-interactive mode
    const clusterSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'AskUserQuestion',
            hooks: [
              {
                type: 'command',
                command: `${containerHome}/.claude/hooks/block-ask-user-question.py`,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify(clusterSettings, null, 2)
    );

    // Track for cleanup
    this.clusterConfigDirs = this.clusterConfigDirs || new Map();
    this.clusterConfigDirs.set(clusterId, configDir);

    return configDir;
  }

  /**
   * Clean up cluster config directory
   * @private
   * @param {string} clusterId - Cluster ID
   */
  _cleanupClusterConfigDir(clusterId) {
    if (!this.clusterConfigDirs?.has(clusterId)) return;

    const configDir = this.clusterConfigDirs.get(clusterId);
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    this.clusterConfigDirs.delete(clusterId);
  }

  /**
   * Preserve Terraform state files before cleanup
   * Checks both terraform/ subdirectory and root directory
   * @private
   * @param {string} clusterId - Cluster ID
   * @param {string} isolatedPath - Path to isolated directory
   */
  _preserveTerraformState(clusterId, isolatedPath) {
    const stateFiles = ['terraform.tfstate', 'terraform.tfstate.backup', 'tfplan'];
    const checkDirs = [isolatedPath, path.join(isolatedPath, 'terraform')];
    const stateDir = path.join(os.homedir(), '.zeroshot', 'terraform-state', clusterId);

    const hasStateFiles = (checkDir) => {
      if (!fs.existsSync(checkDir)) {
        return false;
      }

      return stateFiles.some((file) => fs.existsSync(path.join(checkDir, file)));
    };

    const copyStateFiles = (checkDir) => {
      let copied = false;

      for (const file of stateFiles) {
        const srcPath = path.join(checkDir, file);
        if (!fs.existsSync(srcPath)) {
          continue;
        }

        const destPath = path.join(stateDir, file);
        try {
          fs.copyFileSync(srcPath, destPath);
          console.log(`[IsolationManager] Preserved Terraform state: ${file} → ${stateDir}`);
          copied = true;
        } catch (err) {
          console.warn(`[IsolationManager] Failed to preserve ${file}: ${err.message}`);
        }
      }

      return copied;
    };

    let foundState = false;

    for (const checkDir of checkDirs) {
      if (!hasStateFiles(checkDir)) {
        continue;
      }

      fs.mkdirSync(stateDir, { recursive: true });
      foundState = copyStateFiles(checkDir);
      break;
    }

    if (!foundState) {
      console.log(`[IsolationManager] No Terraform state found to preserve`);
    }
  }

  /**
   * Get host's docker group GID (for Docker socket access inside container)
   * @private
   * @returns {string} Docker group GID
   */
  _getDockerGid() {
    try {
      // Get docker group info: "docker:x:999:user1,user2"
      const result = runSync('getent', ['group', 'docker'], { encoding: 'utf8' });
      const gid = result.split(':')[2];
      return gid.trim();
    } catch {
      // Fallback: common docker GID is 999
      console.warn('[IsolationManager] Could not detect docker GID, using default 999');
      return '999';
    }
  }

  /**
   * Check if a container is running
   * @private
   */
  _isContainerRunning(containerId) {
    try {
      const result = runSync('docker', ['inspect', '-f', '{{.State.Running}}', containerId], {
        encoding: 'utf8',
      });
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Remove container by name (cleanup before create)
   * @private
   */
  _removeContainerByName(name) {
    try {
      runSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    } catch {
      // Ignore - container doesn't exist
    }
  }

  /**
   * Check if Docker is available
   * @returns {boolean}
   */
  static isDockerAvailable() {
    try {
      // Require both CLI binary and a reachable daemon.
      runSync('docker', ['info'], { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the base image exists
   * @param {string} [image] - Image name to check
   * @returns {boolean}
   */
  static imageExists(image = DEFAULT_IMAGE) {
    try {
      runSync('docker', ['image', 'inspect', image], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Registry-owned Docker platform for a provider (e.g. 'linux/amd64'), or null when the
   * provider declares no `docker.platform` (host-native, unset `--platform`).
   * @param {string} providerName
   * @returns {string|null}
   */
  static providerDockerPlatform(providerName) {
    return providerDockerPlatform(providerName);
  }

  /**
   * Registry-owned config/overlay roots for a provider, with $HOME expanded to containerHome.
   * @param {string} providerName
   * @param {string} [containerHome]
   * @returns {string[]}
   */
  static providerConfigRoots(providerName, containerHome = '/root') {
    return providerDockerConfigRootsRaw(providerName).map((root) =>
      root.replace(/\$HOME/g, containerHome)
    );
  }

  /**
   * Parse the exact platform tokens advertised by `docker buildx inspect`.
   *
   * The `Platforms:` line is comma-delimited, and buildx marks preferred entries with a trailing
   * `*`. Tokens are returned verbatim (minus that marker) so callers can compare exactly:
   * `linux/amd64/v2` is a *variant*, not `linux/amd64`, and a substring test would wrongly accept
   * a builder that only advertises the variant. Multiple builder nodes each emit their own
   * `Platforms:` line; all are collected.
   *
   * @param {string} buildxOutput
   * @returns {string[]}
   */
  static parseBuildxPlatforms(buildxOutput) {
    const platforms = [];
    for (const line of (buildxOutput || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('Platforms:')) {
        continue;
      }
      for (const token of trimmed.slice('Platforms:'.length).split(',')) {
        const platform = token.trim().replace(/\*$/, '');
        if (platform) {
          platforms.push(platform);
        }
      }
    }
    return platforms;
  }

  /**
   * Pre-effect probe: throws before any workspace/container side effect when the Docker engine
   * cannot run `platform`. No-op when `platform` is null (provider declares no platform
   * requirement). Native arch match satisfies the platform directly; otherwise a Buildx builder
   * advertising exactly that platform (emulation) is required.
   * @param {string|null} platform
   * @param {{info?: () => string, buildxInspect?: () => string}} [probe] - command runners,
   *   injectable for tests; defaults to the real `docker info` / `docker buildx inspect`
   */
  static assertPlatformSupported(platform, probe = {}) {
    if (!platform) {
      return;
    }

    const runInfo =
      probe.info ||
      (() =>
        runSync('docker', ['info', '--format', '{{.OSType}}|{{.Architecture}}'], {
          encoding: 'utf8',
          stdio: 'pipe',
        }));
    const runBuildxInspect =
      probe.buildxInspect ||
      (() => runSync('docker', ['buildx', 'inspect'], { encoding: 'utf8', stdio: 'pipe' }));

    let info;
    try {
      info = String(runInfo()).trim();
    } catch (err) {
      throw new Error(`Cannot determine Docker engine platform: ${err.message}`);
    }

    const [osType, arch] = info.split('|').map((part) => (part || '').trim());
    const requiredArch = platform.split('/')[1] || '';
    const nativeMatch = arch === requiredArch || (requiredArch === 'amd64' && arch === 'x86_64');

    if (osType === 'linux' && nativeMatch) {
      return;
    }

    let buildxOutput = '';
    if (osType === 'linux') {
      try {
        buildxOutput = String(runBuildxInspect());
      } catch {
        buildxOutput = '';
      }
    }

    if (
      osType === 'linux' &&
      IsolationManager.parseBuildxPlatforms(buildxOutput).includes(platform)
    ) {
      return;
    }

    throw new Error(
      `Docker engine cannot run ${platform} (server ${osType || 'unknown'}/${arch || 'unknown'}, ` +
        `no buildx builder advertising ${platform}). Install Buildx and run: ` +
        `docker run --privileged --rm tonistiigi/binfmt --install ${requiredArch || platform}`
    );
  }

  /**
   * Split a Docker image reference into `{name, tag, digest}` per the reference grammar
   * `[registry[:port]/]name[:tag][@digest]`.
   *
   * The only ambiguity is `:` — it is a registry port when it appears before the last `/`, and a
   * tag separator only when it appears after it. `registry.example:5000/base` therefore has no
   * tag, while `base:v2` does.
   *
   * @param {string} reference
   * @returns {{name: string, tag: string|null, digest: string|null}}
   */
  static parseImageReference(reference) {
    const atIndex = reference.indexOf('@');
    const digest = atIndex === -1 ? null : reference.slice(atIndex + 1);
    const withoutDigest = atIndex === -1 ? reference : reference.slice(0, atIndex);

    const lastSlash = withoutDigest.lastIndexOf('/');
    const colonIndex = withoutDigest.indexOf(':', lastSlash + 1);
    const name = colonIndex === -1 ? withoutDigest : withoutDigest.slice(0, colonIndex);
    const tag = colonIndex === -1 ? null : withoutDigest.slice(colonIndex + 1);

    return { name, tag, digest };
  }

  /**
   * Resolve the cluster image tag for a provider. Providers baked into the base image (e.g.
   * Claude) run on the base image directly; providers with a `docker.install` command get a
   * per-provider image variant `<baseName>-<providerId>-<hash>`.
   *
   * `<baseName>` is the base reference's NAME only. A tag or digest may not be carried over: the
   * derived value is a new locally-built tag, and `registry/base@sha256:…-omp-<hash>` /
   * `base:v2-omp-<hash>` are not valid references (the first is a malformed digest, the second
   * silently reinterprets the tag). A registry port is preserved because it belongs to the name
   * (`registry.example:5000/base` → `registry.example:5000/base-omp-<hash>`).
   *
   * `<hash>` covers the FULL base reference (tag and digest included) alongside the install
   * command and platform, so two different pins of the same base name — or a pinned-version or
   * platform change — never collide on one cached tag.
   *
   * @param {string} providerName
   * @param {string} [baseImage]
   * @returns {string}
   */
  static imageForProvider(providerName, baseImage = DEFAULT_IMAGE) {
    const install = providerDockerInstall(providerName);
    if (!install) {
      return baseImage;
    }
    const platform = providerDockerPlatform(providerName) || '';
    const { name } = IsolationManager.parseImageReference(baseImage);
    const hash = crypto
      .createHash('sha256')
      .update(`${baseImage}\n${platform}\n${install}`)
      .digest('hex')
      .slice(0, 12);
    return `${name}-${normalizeProviderName(providerName)}-${hash}`;
  }

  /**
   * Docker `--build-arg` values that install a provider's CLI (and create its config roots) in
   * its image variant, or [] when the provider is baked into the base image or has no installer.
   * @param {string} providerName
   * @param {string} [containerHome]
   * @returns {string[]}
   */
  static providerBuildArgs(providerName, containerHome = '/home/node') {
    const install = providerDockerInstall(providerName);
    if (!install) {
      return [];
    }
    const args = [`PROVIDER_INSTALL=${install}`];
    const configRoots = IsolationManager.providerConfigRoots(providerName, containerHome);
    if (configRoots.length > 0) {
      args.push(`PROVIDER_CONFIG_ROOTS=${configRoots.join(' ')}`);
    }
    return args;
  }

  /**
   * Build the Docker image with retry logic
   * @param {string} [image] - Image name to build
   * @param {number} [maxRetries=3] - Maximum retry attempts
   * @param {string[]} [buildArgs] - `--build-arg KEY=VALUE` pairs
   * @param {string|null} [platform] - Registry-owned `--platform` value, or null for host-native
   * @returns {Promise<void>}
   */
  static async buildImage(image = DEFAULT_IMAGE, maxRetries = 3, buildArgs = [], platform = null) {
    // Repository root is one level up from src/
    const repoRoot = path.join(__dirname, '..');
    const dockerfilePath = path.join(repoRoot, 'docker', 'zeroshot-cluster', 'Dockerfile');

    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dockerfile not found at ${dockerfilePath}`);
    }

    // Each buildArg becomes a `--build-arg KEY=VALUE` pair (e.g. the per-provider install command).
    const buildArgFlags = [];
    for (const arg of buildArgs) {
      buildArgFlags.push('--build-arg', arg);
    }
    const platformFlags = platform ? ['--platform', platform] : [];

    console.log(`[IsolationManager] Building Docker image '${image}'...`);

    const baseDelay = 3000; // 3 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // CRITICAL: Run from repo root so build context includes package.json and src/
        // Use -f flag to specify Dockerfile location
        runSync(
          'docker',
          [
            'build',
            '-f',
            'docker/zeroshot-cluster/Dockerfile',
            ...platformFlags,
            ...buildArgFlags,
            '-t',
            image,
            '.',
          ],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'inherit',
            // No timeout: image builds legitimately take many minutes (apt, tool downloads,
            // provider install). runSync's 30s default would kill every build (ETIMEDOUT).
            timeout: 0,
          }
        );

        console.log(`[IsolationManager] ✓ Image '${image}' built successfully`);
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(
            `[IsolationManager] ⚠️ Docker build failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
          );
          console.warn(`[IsolationManager] Error: ${err.message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw new Error(
            `Failed to build Docker image '${image}' after ${maxRetries} attempts: ${err.message}`
          );
        }
      }
    }
  }

  /**
   * Ensure Docker image exists, building it if necessary
   * @param {string} [image] - Image name to ensure
   * @param {boolean} [autoBuild=true] - Auto-build if missing
   * @param {string[]} [buildArgs] - `--build-arg KEY=VALUE` pairs
   * @param {string|null} [platform] - Registry-owned `--platform` value, or null for host-native
   * @returns {Promise<void>}
   */
  static async ensureImage(
    image = DEFAULT_IMAGE,
    autoBuild = true,
    buildArgs = [],
    platform = null
  ) {
    if (this.imageExists(image)) {
      return;
    }

    if (!autoBuild) {
      throw new Error(
        `Docker image '${image}' not found. Build it with:\n` +
          `  docker build -t ${image} zeroshot/cluster/docker/zeroshot-cluster/`
      );
    }

    console.log(`[IsolationManager] Image '${image}' not found, building automatically...`);
    await this.buildImage(image, 3, buildArgs, platform);
  }

  /**
   * Check if directory is a git repository
   * @private
   */
  _isGitRepo(dir) {
    try {
      runSync('git', ['rev-parse', '--git-dir'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the git repository root for a directory
   * @private
   */
  _getGitRoot(dir) {
    try {
      return runSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Create worktree-based isolation for a cluster (lightweight alternative to Docker)
   * Creates a git worktree at ~/.zeroshot/worktrees/{clusterId}
   * @param {string} clusterId - Cluster ID
   * @param {string} workDir - Original working directory (must be a git repo)
   * @returns {{ path: string, branch: string, repoRoot: string, baseRef: string, baseSha: string }}
   */
  createWorktreeIsolation(clusterId, workDir, options = {}) {
    if (!this._isGitRepo(workDir)) {
      throw new Error(
        `Worktree isolation requires a git repository. ${workDir} is not a git repo.`
      );
    }

    const worktreeInfo = this.createWorktree(clusterId, workDir, options);
    this.worktrees.set(clusterId, worktreeInfo);

    console.log(`[IsolationManager] Created worktree isolation at ${worktreeInfo.path}`);
    console.log(`[IsolationManager] Branch: ${worktreeInfo.branch}`);

    return worktreeInfo;
  }

  /**
   * Clean up worktree isolation for a cluster
   * @param {string} clusterId - Cluster ID
   * @param {object} [options] - Cleanup options
   * @param {boolean} [options.preserveBranch=true] - Keep the branch after removing worktree
   */
  cleanupWorktreeIsolation(clusterId, options = {}) {
    const worktreeInfo = this.worktrees.get(clusterId);
    if (!worktreeInfo) {
      return; // No worktree to clean up
    }

    this.removeWorktree(worktreeInfo, options);
    this.worktrees.delete(clusterId);

    console.log(`[IsolationManager] Cleaned up worktree isolation for ${clusterId}`);
  }

  /**
   * Create a git worktree for isolated work
   * @param {string} clusterId - Cluster ID (used as branch name)
   * @param {string} workDir - Original working directory
   * @param {object} [options] - Worktree creation options
   * @param {string} [options.baseRef] - Git ref to base the worktree branch on
   * @param {string} [options.remoteName=origin] - Remote used by a remote base ref
   * @param {boolean} [options.requireFreshBase=false] - Require a freshly fetched remote base
   * @param {number} [options.worktreeSetupTimeoutMs] - Setup command timeout in milliseconds
   * @returns {{ path: string, branch: string, repoRoot: string, baseRef: string, baseSha: string }}
   */
  createWorktree(clusterId, workDir, options = {}) {
    const repoRoot = this._getGitRoot(workDir);
    if (!repoRoot) {
      throw new Error(`Cannot find git root for ${workDir}`);
    }
    console.log(`[IsolationManager] Worktree setup phase: preparing git worktree`);
    console.log(`[IsolationManager] Source repo: ${repoRoot}`);

    // Disk space guard: prevent worktree creation when disk is critically low.
    // Uses standalone gc module (no Orchestrator dependency — avoids circular require).
    const { gcOrphanedWorktrees, getDiskSpace, countOrphanedWorktrees } = require('./lib/gc');
    const MIN_DISK_GB = 10;
    const AUTO_GC_THRESHOLD_PERCENT = 80;

    const diskCheck = getDiskSpace(os.homedir());
    if (diskCheck) {
      // Auto-GC when disk usage exceeds threshold
      if (diskCheck.usagePercent > AUTO_GC_THRESHOLD_PERCENT) {
        const orphanCount = countOrphanedWorktrees();
        if (orphanCount > 0) {
          console.log(
            `[IsolationManager] Disk at ${diskCheck.usagePercent.toFixed(0)}% usage, ` +
              `running auto-GC on ${orphanCount} orphaned worktree(s)...`
          );
          const gcResult = gcOrphanedWorktrees();
          if (gcResult.orphanedWorktrees.length > 0 || gcResult.orphanedDbs.length > 0) {
            console.log(
              `[IsolationManager] Auto-GC: removed ${gcResult.orphanedWorktrees.length} worktree(s), ` +
                `${gcResult.orphanedDbs.length} db file(s)`
            );
          }
        }

        // Re-check disk after GC
        const afterGc = getDiskSpace(os.homedir());
        if (afterGc && afterGc.available < MIN_DISK_GB * 1e9) {
          throw new Error(
            `Insufficient disk space: ${(afterGc.available / 1e9).toFixed(1)}GB available, ` +
              `need ${MIN_DISK_GB}GB minimum. Run 'zeroshot gc' to clean up orphaned worktrees, ` +
              `or 'zeroshot purge' to remove all cluster data.`
          );
        }
      } else if (diskCheck.available < MIN_DISK_GB * 1e9) {
        throw new Error(
          `Insufficient disk space: ${(diskCheck.available / 1e9).toFixed(1)}GB available, ` +
            `need ${MIN_DISK_GB}GB minimum. Run 'zeroshot gc' to clean up orphaned worktrees, ` +
            `or 'zeroshot purge' to remove all cluster data.`
        );
      }
    }

    // Priority: 1) options.baseRef, 2) repo settings, 3) HEAD (default)
    let worktreeBaseRef = options.baseRef || null;
    let worktreeSetupCommand = null;
    let repoSettings = {};
    try {
      const repoSettingsResult = readRepoSettings(repoRoot);
      repoSettings = repoSettingsResult.settings || {};
      const candidate = repoSettings.worktree?.baseRef;
      worktreeSetupCommand = repoSettings.worktree?.setup || null;
      if (
        !worktreeBaseRef &&
        typeof candidate === 'string' &&
        /^[A-Za-z0-9._/-]+$/.test(candidate.trim())
      ) {
        worktreeBaseRef = candidate.trim();
      }
    } catch {
      // ignore
    }
    const worktreeSetupTimeoutMs = resolveWorktreeSetupTimeoutMs(repoSettings, options);

    const baseRef = worktreeBaseRef || 'HEAD';
    const remoteName = options.remoteName || 'origin';
    let baseSha;
    let temporaryBaseRef = null;

    if (worktreeBaseRef && worktreeBaseRef.startsWith(`${remoteName}/`)) {
      const branch = worktreeBaseRef.slice(remoteName.length + 1);
      const remoteTrackingRef = `refs/remotes/${remoteName}/${branch}`;

      if (options.requireFreshBase === true) {
        const freshBase = fetchFreshRemoteBase(repoRoot, remoteName, branch);
        baseSha = freshBase.baseSha;
        temporaryBaseRef = freshBase.temporaryRef;
      } else {
        try {
          runSync(
            'git',
            ['fetch', '--no-tags', '--', remoteName, `+refs/heads/${branch}:${remoteTrackingRef}`],
            {
              cwd: repoRoot,
              encoding: 'utf8',
              stdio: 'pipe',
            }
          );
        } catch {
          // Repository worktree settings historically allowed an offline cached remote ref.
        }
        baseSha = resolveCommit(repoRoot, remoteTrackingRef);
      }
    } else {
      baseSha = resolveCommit(repoRoot, baseRef);
    }

    console.log(`[IsolationManager] Worktree base ref: ${baseRef}`);
    console.log(`[IsolationManager] Worktree base commit: ${baseSha}`);

    // Create branch name from cluster ID (e.g., cluster-cosmic-meteor-87 -> zeroshot/cosmic-meteor-87)
    const baseBranchName = `zeroshot/${clusterId.replace(/^cluster-/, '')}`;
    let branchName = baseBranchName;

    // Worktree path in persistent location (survives reboots)
    const worktreePath = path.join(os.homedir(), '.zeroshot', 'worktrees', clusterId);

    try {
      // Ensure parent directory exists
      const parentDir = path.dirname(worktreePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Best-effort cleanup of stale worktree metadata and directory.
      // IMPORTANT: If a previous run deleted the directory without deregistering the worktree,
      // git may keep the branch "checked out" and block deletion/reuse.
      try {
        runSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        // ignore
      }
      try {
        runSync('git', ['worktree', 'prune'], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        // ignore
      }
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }

      console.log(`[IsolationManager] Worktree path: ${worktreePath}`);

      // Create worktree with new branch based on baseRef (retry on branch collision/in-use)
      for (let attempt = 0; attempt < 10; attempt++) {
        // Best-effort delete if branch exists and is not in use by another worktree.
        try {
          runSync('git', ['branch', '-D', branchName], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch {
          // ignore
        }

        try {
          runSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseSha], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'pipe',
          });
          console.log(`[IsolationManager] Worktree setup phase: created branch ${branchName}`);
          break;
        } catch (err) {
          const stderr = (
            err && (err.stderr || err.message) ? String(err.stderr || err.message) : ''
          ).toLowerCase();
          const isBranchCollision =
            stderr.includes('already exists') ||
            stderr.includes('cannot delete branch') ||
            stderr.includes('checked out');

          if (attempt < 9 && isBranchCollision) {
            branchName = `${baseBranchName}-${crypto.randomBytes(3).toString('hex')}`;
            try {
              runSync('git', ['worktree', 'prune'], {
                cwd: repoRoot,
                encoding: 'utf8',
                stdio: 'pipe',
              });
            } catch {
              // ignore
            }
            continue;
          }
          throw err;
        }
      }
    } finally {
      if (temporaryBaseRef) {
        deleteTemporaryBaseRef(repoRoot, temporaryBaseRef);
      }
    }

    // Run repo-configured setup command (e.g. npm ci)
    if (worktreeSetupCommand && typeof worktreeSetupCommand === 'string') {
      console.log(`[IsolationManager] Worktree setup phase: running repo setup command`);
      console.log(
        `[IsolationManager] Setup command: ${worktreeSetupCommand} ` +
          `(timeout ${worktreeSetupTimeoutMs}ms)`
      );
      console.log(`[IsolationManager] Setup command output follows`);
      runShellSync(worktreeSetupCommand, {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: 'inherit',
        timeout: worktreeSetupTimeoutMs,
      });
      console.log(`[IsolationManager] Worktree setup phase: repo setup command complete`);
    }

    console.log(`[IsolationManager] ✓ Worktree setup complete`);

    return {
      path: worktreePath,
      branch: branchName,
      repoRoot,
      baseRef,
      baseSha,
    };
  }

  /**
   * Kill detached processes whose command line is scoped to a worktree path.
   * Claude Code hook daemons survive agent shutdown because they run detached
   * and keep the worktree path in argv; cleaning them up here prevents orphaned
   * daemons from accumulating across stopped or deleted worktrees.
   * @param {string} worktreePath
   * @returns {number[]} PIDs signalled with SIGTERM
   */
  cleanupWorktreeProcesses(worktreePath) {
    if (!worktreePath || process.platform === 'win32') {
      return [];
    }

    let processList = '';
    try {
      processList = runSync('ps', ['axww', '-o', 'pid=,command='], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      return [];
    }

    const resolvedWorktreePath = path.resolve(worktreePath);
    const signalledPids = [];

    for (const line of String(processList).split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) {
        continue;
      }

      const pid = Number.parseInt(match[1], 10);
      const command = match[2];
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        continue;
      }

      if (!command.includes(resolvedWorktreePath)) {
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        signalledPids.push(pid);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }

    return signalledPids;
  }

  /**
   * Remove a git worktree
   * @param {{ path: string, branch: string, repoRoot: string }} worktreeInfo
   * @param {object} [options] - Removal options
   * @param {boolean} [options.deleteBranch=false] - Also delete the branch
   */
  removeWorktree(worktreeInfo, _options = {}) {
    this.cleanupWorktreeProcesses(worktreeInfo.path);

    // Tear down any Docker Compose services that may have been started in this worktree.
    // Without this, containers keep running with host port mappings after the worktree is deleted,
    // blocking port allocation for the main project or other worktrees.
    // NEVER pass --volumes (irreversible data loss) and NEVER tear down a pinned/shared
    // Compose project — only a project scoped to the worktree directory basename, which is
    // the only kind zeroshot could itself have created, is touched.
    const { resolveWorktreeComposeTeardown } = require('../lib/compose-utils');
    const teardown = resolveWorktreeComposeTeardown(worktreeInfo.path);
    if (teardown.shouldTeardown) {
      try {
        runSync('docker', teardown.args, {
          cwd: worktreeInfo.path,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch {
        // Best-effort: compose project may not have been started, or Docker may not be running
      }
    }

    // Remove the worktree (prefer git so metadata is cleaned up).
    try {
      runSync('git', ['worktree', 'remove', '--force', worktreeInfo.path], {
        cwd: worktreeInfo.repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      // If git worktree metadata is stale, prune and retry once.
      try {
        runSync('git', ['worktree', 'prune'], {
          cwd: worktreeInfo.repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        // ignore
      }
      try {
        runSync('git', ['worktree', 'remove', '--force', worktreeInfo.path], {
          cwd: worktreeInfo.repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        // Last resort: delete directory, then prune stale worktree entries.
        try {
          fs.rmSync(worktreeInfo.path, { recursive: true, force: true });
        } catch {
          // ignore
        }
        try {
          runSync('git', ['worktree', 'prune'], {
            cwd: worktreeInfo.repoRoot,
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch {
          // ignore
        }
      }
    }

    // Optionally delete the branch (only if not merged)
    // We leave this commented out - let the user decide to keep/delete branches
    // try {
    //   execSync(`git branch -D "${worktreeInfo.branch}" 2>/dev/null`, {
    //     cwd: worktreeInfo.repoRoot,
    //     encoding: 'utf8',
    //     stdio: 'pipe'
    //   });
    // } catch {
    //   // Ignore - branch may have been merged or deleted
    // }
  }

  /**
   * Get worktree info for a cluster
   * @param {string} clusterId - Cluster ID
   * @returns {{ path: string, branch: string, repoRoot: string }|undefined}
   */
  getWorktreeInfo(clusterId) {
    return this.worktrees.get(clusterId);
  }
}

module.exports = IsolationManager;
