/**
 * Preflight Validation - Check all dependencies before starting
 *
 * Validates:
 * - Selected provider CLI installed
 * - gh CLI installed and authenticated (if using issue numbers)
 * - Docker available (if using --docker)
 *
 * Provides CLEAR, ACTIONABLE error messages with recovery instructions.
 */

const { execSync } = require('./lib/safe-exec'); // Enforces timeouts
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  isValidAnthropicKey,
  ANTHROPIC_KEY_PREFIX,
  resolveClaudeAuth,
} = require('../lib/settings/claude-auth.js');
const { loadSettings, getClaudeCommand } = require('../lib/settings.js');
const {
  VALID_PROVIDERS,
  getProviderMetadata,
  normalizeProviderName,
  resolveProviderCommand,
} = require('../lib/provider-names');
const { detectGitContext } = require('../lib/git-remote-utils');
const { readKeychainCredentials } = require('./claude-credentials');

/**
 * Validation result
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string[]} errors - Fatal errors that block execution
 * @property {string[]} warnings - Non-fatal warnings
 */

/**
 * Format error with recovery instructions
 * @param {string} title - Error title
 * @param {string} detail - Error details
 * @param {string[]} recovery - Recovery steps
 * @returns {string}
 */
function formatError(title, detail, recovery) {
  let msg = `\n❌ ${title}\n`;
  msg += `   ${detail}\n`;
  if (recovery.length > 0) {
    msg += `\n   To fix:\n`;
    recovery.forEach((step, i) => {
      msg += `   ${i + 1}. ${step}\n`;
    });
  }
  return msg;
}

/**
 * Check if a command exists (cross-platform)
 * @param {string} cmd - Command to check
 * @returns {boolean}
 */
function commandExists(cmd) {
  try {
    // Windows uses 'where', Unix uses 'which'
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Claude CLI version
 * @param {string} claudeCommand - Optional custom Claude command (e.g., 'ccr code')
 * @returns {{ installed: boolean, version: string | null, error: string | null }}
 */
function getClaudeVersion(claudeCommand = 'claude') {
  // Parse command parts
  const parts = claudeCommand.trim().split(/\s+/);
  const command = parts[0];
  const extraArgs = parts.slice(1);

  // Determine CLI presence without depending on `claude --version` working.
  // Some environments can have Claude installed but a broken/unwritable config dir,
  // which should NOT block preflight.
  if (!commandExists(command)) {
    return {
      installed: false,
      version: null,
      error: `Command '${command}' not installed`,
    };
  }

  try {
    const versionArgs = [...extraArgs, '--version'];
    const versionCmd = [command, ...versionArgs].join(' ');
    // Claude Code may try to write debug output under CLAUDE_CONFIG_DIR even for `--version`.
    // Preflight should detect installation, not fail due to an unwritable/invalid config dir.
    const preflightConfigDir = path.join(os.tmpdir(), 'zeroshot-claude-preflight');
    try {
      fs.mkdirSync(preflightConfigDir, { recursive: true });
    } catch {
      // If we can't create it, fall back to current env.
    }
    const output = execSync(versionCmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: preflightConfigDir,
      },
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return {
      installed: true,
      version: match ? match[1] : 'unknown',
      error: null,
    };
  } catch {
    // The CLI exists, but the version command can still fail due to local environment
    // (e.g. config-dir permissions). Treat this as installed with unknown version so
    // preflight doesn't block on non-essential metadata.
    return {
      installed: true,
      version: 'unknown',
      error: null,
    };
  }
}

/**
 * Check macOS Keychain for Claude Code credentials
 * @returns {{ authenticated: boolean, error: string | null }}
 */
function checkMacOsKeychain() {
  if (os.platform() !== 'darwin') {
    return { authenticated: false, error: 'Not macOS' };
  }

  // Reuses the same Keychain read that provisions isolated agent configs, so a
  // green preflight here genuinely predicts runtime auth availability.
  if (readKeychainCredentials()) {
    return { authenticated: true, error: null };
  }
  return { authenticated: false, error: 'No credentials in Keychain' };
}

/**
 * Check Claude CLI authentication status
 * @returns {{ authenticated: boolean, error: string | null, configDir: string, method?: string }}
 */
function checkClaudeAuth() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

  // Helper to create consistent result objects
  const authResult = (authenticated, error = null, method = null) => ({
    authenticated,
    error,
    configDir,
    ...(method && { method }),
  });

  // Check for Bedrock bearer token (highest priority)
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    if (!process.env.AWS_REGION) {
      return authResult(false, 'AWS_BEARER_TOKEN_BEDROCK set but AWS_REGION is missing');
    }
    return authResult(true, null, 'bedrock_api_key');
  }

  // Check for ANTHROPIC_API_KEY environment variable
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY;
  if (apiKeyEnv) {
    if (!isValidAnthropicKey(apiKeyEnv)) {
      return authResult(false, `ANTHROPIC_API_KEY must start with ${ANTHROPIC_KEY_PREFIX}`);
    }
    return authResult(true, null, 'env_api_key');
  }

  // Check for settings-based auth (anthropicApiKey or bedrockApiKey in settings)
  const settings = loadSettings();
  const settingsAuth = resolveClaudeAuth(settings);
  if (settingsAuth.ANTHROPIC_API_KEY) {
    return authResult(true, null, 'settings_api_key');
  }
  if (settingsAuth.AWS_BEARER_TOKEN_BEDROCK) {
    if (!settingsAuth.AWS_REGION && !process.env.AWS_REGION) {
      return authResult(false, 'Bedrock configured in settings but AWS_REGION is missing');
    }
    return authResult(true, null, 'settings_bedrock');
  }

  const credentialsPath = path.join(configDir, '.credentials.json');

  // Check if credentials file exists
  if (!fs.existsSync(credentialsPath)) {
    // No credentials file - check macOS Keychain as fallback
    // Only use Keychain when using default config dir (not custom CLAUDE_CONFIG_DIR)
    if (!process.env.CLAUDE_CONFIG_DIR && checkMacOsKeychain().authenticated) {
      return authResult(true, null, 'keychain');
    }
    return authResult(false, 'No credentials file found');
  }

  // Check if credentials file has content
  try {
    const content = fs.readFileSync(credentialsPath, 'utf8');
    const creds = JSON.parse(content);

    // Check for OAuth token (primary auth method)
    if (creds.claudeAiOauth?.accessToken) {
      const expiresAt = creds.claudeAiOauth.expiresAt;
      if (expiresAt && new Date(expiresAt) < new Date()) {
        return authResult(false, 'OAuth token expired');
      }
      return authResult(true);
    }

    // Check for API key auth
    if (creds.apiKey) {
      return authResult(true);
    }

    return authResult(false, 'No valid authentication found in credentials');
  } catch (err) {
    return authResult(false, `Failed to parse credentials: ${err.message}`);
  }
}

/**
 * Check gh CLI authentication status
 * @returns {{ installed: boolean, authenticated: boolean, error: string | null }}
 */
function checkGhAuth() {
  // Check if gh is installed
  if (!commandExists('gh')) {
    return {
      installed: false,
      authenticated: false,
      error: 'gh CLI not installed',
    };
  }

  // Check auth status with timeout to prevent hangs
  // gh auth status: exit 0 = authenticated, exit 1 = not authenticated
  // Note: gh outputs to stderr even on success
  const AUTH_CHECK_TIMEOUT_MS = 10000;
  try {
    execSync('gh auth status', {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: AUTH_CHECK_TIMEOUT_MS,
    });
    // Exit code 0 = authenticated
    return {
      installed: true,
      authenticated: true,
      error: null,
    };
  } catch (err) {
    const stderr = err.stderr || '';

    // Check if killed due to timeout
    if (err.killed || err.signal === 'SIGTERM') {
      return {
        installed: true,
        authenticated: false,
        error: 'gh auth status timed out - try running: gh auth login',
      };
    }

    // gh auth status returns non-zero if not authenticated
    // Check stderr for common "not logged in" patterns
    if (
      stderr.includes('not logged in') ||
      stderr.includes('not logged into') ||
      stderr.includes('You are not logged')
    ) {
      return {
        installed: true,
        authenticated: false,
        error: 'gh CLI not authenticated',
      };
    }

    // But if stderr contains "Logged in", trust that (some edge cases)
    if (stderr.includes('Logged in')) {
      return {
        installed: true,
        authenticated: true,
        error: null,
      };
    }

    // Provide more helpful error - include actual stderr for debugging
    const details = stderr.trim() || `Exit code ${err.status || 'unknown'}`;
    return {
      installed: true,
      authenticated: false,
      error: `gh auth check failed: ${details}`,
    };
  }
}

/**
 * Check Docker availability
 * @returns {{ available: boolean, error: string | null }}
 */
function checkDocker() {
  try {
    execSync('docker --version', { encoding: 'utf8', stdio: 'pipe' });

    // Also check if Docker daemon is running
    execSync('docker info', { encoding: 'utf8', stdio: 'pipe' });

    return {
      available: true,
      error: null,
    };
  } catch (err) {
    const stderr = err.stderr || err.message || '';

    if (stderr.includes('command not found') || stderr.includes('not found')) {
      return {
        available: false,
        error: 'Docker not installed',
      };
    }

    if (stderr.includes('Cannot connect') || stderr.includes('Is the docker daemon running')) {
      return {
        available: false,
        error: 'Docker daemon not running',
      };
    }

    return {
      available: false,
      error: stderr.trim() || 'Unknown Docker error',
    };
  }
}

function buildClaudeCommand(options) {
  const { command, args } = getClaudeCommand();
  return options.claudeCommand || [command, ...args].join(' ');
}

function buildRegistryInstallRecovery(metadata, command) {
  return [
    ...metadata.installInstructions.split('\n').filter(Boolean),
    `Then run: ${command} --version`,
  ];
}

function validateClaudeProvider(options) {
  const errors = [];
  const warnings = [];
  const metadata = getProviderMetadata('claude');
  const claudeCommand = buildClaudeCommand(options);
  const claudeCommandParts = claudeCommand.trim().split(/\s+/);
  const usesDefaultClaudeCommand =
    claudeCommandParts.length === 1 && claudeCommandParts[0] === metadata.binary;

  const claude = getClaudeVersion(claudeCommand);
  if (!claude.installed) {
    errors.push(
      formatError(
        'Claude command not available',
        claude.error,
        usesDefaultClaudeCommand
          ? buildRegistryInstallRecovery(metadata, metadata.binary)
          : [
              `Command '${claudeCommand}' not found`,
              'Check settings: zeroshot settings',
              'Update claudeCommand: zeroshot settings set claudeCommand "your-command"',
              'Or install the missing command',
            ]
      )
    );
  } else if (claude.version) {
    const [major, minor] = claude.version.split('.').map(Number);
    if (major < 1 || (major === 1 && minor < 0)) {
      warnings.push(
        `⚠️  Claude CLI version ${claude.version} may be outdated. Consider upgrading.`
      );
    }
  }

  if (process.getuid && process.getuid() === 0) {
    errors.push(
      formatError(
        'Running as root',
        'Claude CLI refuses --dangerously-skip-permissions flag when running as root (UID 0)',
        [
          'Run as non-root user in Docker: docker run --user 1000:1000 ...',
          'Or create non-root user: adduser testuser && su - testuser',
          'Or use existing node user: docker run --user node ...',
          'Security: Claude CLI blocks this flag as root to prevent privilege escalation',
        ]
      )
    );
  }

  return { errors, warnings };
}

function validateCliProvider(command, title, detail, recovery) {
  const errors = [];
  if (!commandExists(command)) {
    errors.push(formatError(title, detail, recovery));
  }

  return { errors, warnings: [] };
}

function validateGatewayProvider() {
  const { getProvider } = require('./providers');
  const provider = getProvider('gateway');
  if (provider.isAvailable()) {
    return { errors: [], warnings: [] };
  }
  return {
    errors: [
      formatError(
        'Gateway provider not configured',
        'providerSettings.gateway must define protocol, baseUrl, apiKey, model, and toolPolicy before gateway can run.',
        [
          'Run: zeroshot settings',
          'Set providerSettings.gateway.protocol and baseUrl for your compatible endpoint',
          'Set providerSettings.gateway.apiKey and providerSettings.gateway.model',
          'Set providerSettings.gateway.maxTokens when protocol is anthropic',
          'Set providerSettings.gateway.toolPolicy.roots and toolPolicy.commands explicitly',
        ]
      ),
    ],
    warnings: [],
  };
}

function validateProvider(providerName, options) {
  let metadata;
  try {
    metadata = getProviderMetadata(providerName);
  } catch {
    return {
      errors: [
        formatError('Unknown provider', `Provider "${providerName}" is not supported`, [
          `Use ${VALID_PROVIDERS.join(', ')}`,
        ]),
      ],
      warnings: [],
    };
  }

  if (metadata.command.kind === 'configured-claude') {
    return validateClaudeProvider(options);
  }
  if (providerName === 'gateway') {
    return validateGatewayProvider();
  }

  return validateRegistryCliProvider(providerName);
}

function validateRegistryCliProvider(providerName) {
  const metadata = getProviderMetadata(providerName);
  const { command } = resolveProviderCommand(providerName);
  const installSteps = metadata.installInstructions.split('\n').filter(Boolean);
  if (!commandExists(command)) {
    return validateCliProvider(
      command,
      `${metadata.displayName} CLI not available`,
      `Command "${command}" not installed`,
      [...installSteps, `Then run: ${command} --version`]
    );
  }

  const { getProvider } = require('./providers');
  if (getProvider(providerName).isAvailable()) {
    return { errors: [], warnings: [] };
  }

  return {
    errors: [
      formatError(
        `${metadata.displayName} CLI not available`,
        `Command "${command}" is installed but did not produce usable --help/--version output`,
        [...installSteps, `Then run: ${command} --version`]
      ),
    ],
    warnings: [],
  };
}

function validateGhRequirement() {
  const errors = [];
  const gh = checkGhAuth();
  if (!gh.installed) {
    errors.push(
      formatError('GitHub CLI (gh) not installed', 'Required for fetching issues by number', [
        'Install: brew install gh (macOS) or apt install gh (Linux)',
        'Or download from: https://cli.github.com/',
      ])
    );
  } else if (!gh.authenticated) {
    errors.push(
      formatError('GitHub CLI (gh) not authenticated', gh.error, [
        'Run: gh auth login',
        'Select GitHub.com, HTTPS, and authenticate via browser',
        'Then verify: gh auth status',
      ])
    );
  }

  return errors;
}

function validateDockerRequirement() {
  const errors = [];
  const docker = checkDocker();
  if (!docker.available) {
    errors.push(
      formatError(
        'Docker not available',
        docker.error,
        docker.error.includes('daemon')
          ? ['Start Docker Desktop', 'Or run: sudo systemctl start docker (Linux)']
          : [
              'Install Docker Desktop from: https://docker.com/products/docker-desktop',
              'Then start Docker and verify: docker info',
            ]
      )
    );
  }

  return errors;
}

function isGitRepository() {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function validateGitRequirement() {
  if (isGitRepository()) {
    return [];
  }

  return [
    formatError('Not in a git repository', 'Worktree isolation requires a git repository', [
      'Run from within a git repository',
      'Or use --docker instead of --worktree for non-git directories',
      'Initialize a repo with: git init',
    ]),
  ];
}

/**
 * Run all preflight checks
 * @param {Object} options - Preflight options
 * @param {boolean} options.requireGh - Whether gh CLI is required (true if using issue number)
 * @param {boolean} options.requireDocker - Whether Docker is required (true if using --docker)
 * @param {boolean} options.requireGit - Whether git repo is required (true if using --worktree)
 * @param {boolean} options.quiet - Suppress success messages
 * @param {string} options.claudeCommand - Custom Claude command (from settings)
 * @param {string} options.provider - Provider override
 * @returns {ValidationResult}
 */
async function runPreflight(options = {}) {
  const errors = [];
  const warnings = [];

  const settings = loadSettings();

  if (process.platform === 'win32') {
    return {
      valid: false,
      errors: [
        formatError(
          'Windows not supported',
          'Zeroshot currently supports Linux and macOS only; Windows (native or WSL) is deferred.',
          [
            'Use Linux or macOS to run Zeroshot',
            'Or run inside a Linux VM/container on Windows',
            'Check README for supported platforms and updates',
          ]
        ),
      ],
      warnings: [],
    };
  }
  const providerName = normalizeProviderName(
    options.provider || settings.defaultProvider || 'claude'
  );

  const providerResult = validateProvider(providerName, options);
  errors.push(...providerResult.errors);
  warnings.push(...providerResult.warnings);

  // 4. Check issue provider CLI (if required)
  if (options.issueProvider) {
    const { getProvider } = require('./issue-providers');
    const ProviderClass = getProvider(options.issueProvider);

    if (ProviderClass) {
      const tool = ProviderClass.getRequiredTool();

      // Check if tool is installed (providers with no CLI binary set tool.name to null)
      if (tool.name && !commandExists(tool.name)) {
        errors.push(
          formatError(
            `${ProviderClass.displayName} CLI (${tool.name}) not installed`,
            `Required for fetching ${ProviderClass.displayName} issues`,
            [tool.installHint, `Then verify: ${tool.checkCmd}`]
          )
        );
      } else {
        // Check provider authentication (abstracted per provider)
        // Use targetHost from URL input if provided, otherwise detect from git context
        // This ensures we check auth for the actual target, not the current repo
        const targetHost =
          options.targetHost || detectGitContext(options.cwd || process.cwd())?.host;
        const authResult = await ProviderClass.checkAuth(targetHost);
        if (!authResult.authenticated) {
          errors.push(
            formatError(
              `${ProviderClass.displayName} CLI (${tool.name}) not authenticated`,
              authResult.error,
              authResult.recovery
            )
          );
        }
      }
    }
  }

  // 5. Check PR/MR CLI tools (if --pr or --ship mode is active)
  if (options.autoPr) {
    const { getPlatformForPR, getPRToolForPlatform, getProvider } = require('./issue-providers');

    let platform;
    let prGitContext;
    try {
      // Detect git platform (independent of issue provider)
      platform = getPlatformForPR(options.cwd || process.cwd());
      // Get git context for hostname (needed for multi-instance auth checks)
      prGitContext = detectGitContext(options.cwd || process.cwd());
    } catch (error) {
      // If platform detection fails, show clear error
      errors.push(
        formatError('--pr mode requires a git repository', error.message, [
          'Ensure you are in a git repository with a remote URL from GitHub, GitLab, or Azure DevOps',
        ])
      );
      // Skip CLI tool check if platform unknown
    }

    if (platform) {
      // Get PR tool info from the provider (unified source of truth)
      const tool = getPRToolForPlatform(platform);
      const ProviderClass = getProvider(platform);

      if (tool && !commandExists(tool.name)) {
        errors.push(
          formatError(
            `${tool.displayName} CLI (${tool.name}) not installed`,
            `Required for --pr mode with ${tool.displayName} repositories`,
            [tool.installHint, `Then verify: ${tool.checkCmd}`]
          )
        );
      } else if (tool && ProviderClass) {
        // Check provider authentication (abstracted per provider)
        // Pass hostname for multi-instance providers (e.g., GitLab with self-hosted)
        const authResult = await ProviderClass.checkAuth(prGitContext?.host);
        if (!authResult.authenticated) {
          errors.push(
            formatError(
              `${tool.displayName} CLI (${tool.name}) not authenticated`,
              authResult.error,
              authResult.recovery
            )
          );
        }
      }
    }
  }

  // Legacy gh check for backward compatibility
  if (options.requireGh) {
    errors.push(...validateGhRequirement());
  }

  // 6. Check Docker (if required)
  if (options.requireDocker) {
    errors.push(...validateDockerRequirement());
  }

  // 7. Check git repo (if required for worktree isolation)
  if (options.requireGit) {
    errors.push(...validateGitRequirement());
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Run preflight checks and exit if failed
 * @param {Object} options - Preflight options
 * @param {boolean} options.requireGh - Whether gh CLI is required
 * @param {boolean} options.requireDocker - Whether Docker is required
 * @param {boolean} options.requireGit - Whether git repo is required
 * @param {boolean} options.quiet - Suppress success messages
 * @param {string} options.provider - Provider override
 */
async function requirePreflight(options = {}) {
  const result = await runPreflight(options);

  // Print warnings regardless of success
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(warning);
    }
  }

  if (!result.valid) {
    console.error('\n' + '='.repeat(60));
    console.error('PREFLIGHT CHECK FAILED');
    console.error('='.repeat(60));

    for (const error of result.errors) {
      console.error(error);
    }

    console.error('='.repeat(60) + '\n');
    process.exit(1);
  }

  if (!options.quiet) {
    console.log('✓ Preflight checks passed');
  }
}

module.exports = {
  runPreflight,
  requirePreflight,
  getClaudeVersion,
  checkClaudeAuth,
  checkGhAuth,
  checkDocker,
  formatError,
};
