/**
 * Git remote URL parsing and provider detection.
 * Automatically detects issue provider from git remote URL.
 */

const { execSync } = require('../src/lib/safe-exec');

function hasInvalidGitRefCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x20 || codePoint === 0x7f || '~^:?*[\\'.includes(character)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a Git remote name using the same ref-format rules Git applies to
 * refs/remotes/<name>. Keeping this next to detection prevents a discovered
 * remote from being rejected later by a narrower consumer-specific allowlist.
 *
 * @param {unknown} value - Candidate remote name
 * @returns {string|null} Normalized remote name, or null when invalid
 */
function normalizeGitRemoteName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const name = value.trim();
  if (
    name.length === 0 ||
    name.endsWith('.') ||
    name.includes('..') ||
    name.includes('@{') ||
    hasInvalidGitRefCharacter(name)
  ) {
    return null;
  }

  const components = name.split('/');
  if (
    components.some(
      (component) =>
        component.length === 0 || component.startsWith('.') || component.endsWith('.lock')
    )
  ) {
    return null;
  }

  return name;
}

/**
 * Quote one argument for the POSIX shell snippets embedded in agent prompts.
 *
 * @param {string} value - Argument to quote
 * @returns {string} Single-quoted shell argument
 */
function quoteShellArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Parse git remote URL into structured provider context.
 * Supports GitHub, GitLab, and Azure DevOps (cloud + self-hosted).
 * Handles both HTTPS and SSH URL formats.
 *
 * @param {string} remoteUrl - Git remote URL
 * @returns {Object|null} Provider context or null if unparseable
 *
 * @example
 * parseGitRemoteUrl('https://github.com/org/repo.git')
 * // → { provider: 'github', host: 'github.com', org: 'org', repo: 'repo', fullRepo: 'org/repo' }
 *
 * @example
 * parseGitRemoteUrl('git@gitlab.com:org/repo.git')
 * // → { provider: 'gitlab', host: 'gitlab.com', org: 'org', repo: 'repo', fullRepo: 'org/repo' }
 *
 * @example
 * parseGitRemoteUrl('https://dev.azure.com/myorg/myproject/_git/myrepo')
 * // → { provider: 'azure-devops', host: 'dev.azure.com', azureOrg: 'https://dev.azure.com/myorg', azureProject: 'myproject', repo: 'myrepo' }
 */
function parseGitRemoteUrl(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return null;
  }

  const url = remoteUrl.trim();

  // Normalize SSH URLs to HTTPS format for easier parsing
  // git@host:path → https://host/path
  let normalizedUrl = url;
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    normalizedUrl = `https://${host}/${path}`;
  }

  // Remove .git suffix if present
  normalizedUrl = normalizedUrl.replace(/\.git$/, '');

  // Azure DevOps: https://dev.azure.com/org/project/_git/repo
  // Azure Legacy: https://org.visualstudio.com/project/_git/repo
  // Azure SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const azureMatch =
    normalizedUrl.match(/https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/) ||
    normalizedUrl.match(/https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/) ||
    // After normalization, `git@ssh.dev.azure.com:v3/org/project/repo` becomes
    // `https://ssh.dev.azure.com/v3/org/project/repo`
    normalizedUrl.match(/https:\/\/ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)/);

  if (azureMatch) {
    const [, orgPart, project, repo] = azureMatch;
    // For dev.azure.com, org is the first path segment
    // For visualstudio.com, org is the subdomain
    const isLegacy = normalizedUrl.includes('visualstudio.com');
    const azureOrg = isLegacy
      ? `https://${orgPart}.visualstudio.com`
      : `https://dev.azure.com/${orgPart}`;

    return {
      provider: 'azure-devops',
      host: isLegacy ? `${orgPart}.visualstudio.com` : 'dev.azure.com',
      azureOrg,
      azureProject: project,
      repo,
    };
  }

  // GitHub: https://github.com/org/repo
  // GitLab: https://gitlab.com/org/repo (or self-hosted)
  // Generic: https://host/org/repo
  const httpsMatch = normalizedUrl.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/]+)/);
  if (httpsMatch) {
    const [, host, org, repo] = httpsMatch;

    let provider = null;
    if (host === 'github.com') {
      provider = 'github';
    } else if (host.includes('gitlab')) {
      // Matches gitlab.com or any gitlab.* subdomain or *gitlab* in hostname
      provider = 'gitlab';
    } else {
      // Unknown provider - could be self-hosted GitLab or other
      // Return null to fall back to settings
      return null;
    }

    return {
      provider,
      host,
      org,
      repo,
      fullRepo: `${org}/${repo}`,
    };
  }

  return null;
}

/**
 * Detect git repository context from current working directory.
 * Returns provider context extracted from git remote URL.
 *
 * @param {string} [cwd=process.cwd()] - Directory to check
 * @returns {Object|null} Git context or null
 *
 * Gracefully returns null for:
 * - Not in git repository
 * - No remote configured
 * - Remote URL unparseable
 * - Git command fails
 *
 * @example
 * // In a GitHub repo with remote
 * detectGitContext()
 * // → { provider: 'github', host: 'github.com', org: 'myorg', repo: 'myrepo', fullRepo: 'myorg/myrepo' }
 *
 * @example
 * // Not in git repo or no remote
 * detectGitContext()
 * // → null
 */
function detectGitContext(cwd = process.cwd()) {
  try {
    // Check if we're in a git repository
    execSync('git rev-parse --git-dir', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch {
    // Not a git repository
    return null;
  }

  try {
    const remoteOutput = execSync('git remote -v', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    const supportedRemotes = new Map();
    for (const line of remoteOutput.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(.+?)\s+\(fetch\)(?:\s+\[[^\]\r\n]+\])?$/);
      if (!match) {
        continue;
      }

      const [, remoteCandidate, remoteUrl] = match;
      const remote = normalizeGitRemoteName(remoteCandidate);
      if (!remote) {
        continue;
      }
      const context = parseGitRemoteUrl(remoteUrl);
      if (context && !supportedRemotes.has(remote)) {
        supportedRemotes.set(remote, { ...context, remote });
      }
    }

    // Preserve existing behavior whenever origin is usable. Without origin,
    // select a remote only when there is exactly one supported target. Guessing
    // between multiple repositories could push code or create a PR in the wrong
    // place, so ambiguous configurations deliberately fail closed.
    if (supportedRemotes.has('origin')) {
      return supportedRemotes.get('origin');
    }

    if (supportedRemotes.size === 1) {
      return supportedRemotes.values().next().value;
    }

    return null;
  } catch {
    // No remote configured or command failed
    return null;
  }
}

module.exports = {
  normalizeGitRemoteName,
  quoteShellArgument,
  parseGitRemoteUrl,
  detectGitContext,
};
