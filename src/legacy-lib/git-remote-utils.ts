/**
 * Git remote URL parsing and provider detection.
 * Automatically detects issue provider from git remote URL.
 */

interface ExecSyncOptions {
  cwd: string;
  encoding: 'utf8';
  stdio: 'pipe';
}

type ExecSync = (command: string, options: ExecSyncOptions) => string;

interface SafeExecFacade {
  execSync: ExecSync;
}

interface HostedGitContext {
  provider: 'github' | 'gitlab';
  host: string;
  org: string;
  repo: string;
  fullRepo: string;
}

interface AzureDevOpsGitContext {
  provider: 'azure-devops';
  host: string;
  azureOrg: string;
  azureProject: string;
  repo: string;
}

type GitContext = HostedGitContext | AzureDevOpsGitContext;
type GitContextWithRemote = GitContext & { remote: string };

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const safeExec: SafeExecFacade = require('../src/lib/safe-exec');
const { execSync } = safeExec;

function hasInvalidGitRefCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      '~^:?*[\\'.includes(character)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a Git remote name using the same ref-format rules Git applies to
 * refs/remotes/<name>. Keeping this next to detection prevents a discovered
 * remote from being rejected later by a narrower consumer-specific allowlist.
 */
function normalizeGitRemoteName(value: unknown): string | null {
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

/** Quote one argument for the POSIX shell snippets embedded in agent prompts. */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Parse git remote URL into structured provider context.
 * Supports GitHub, GitLab, and Azure DevOps (cloud + self-hosted).
 * Handles both HTTPS and SSH URL formats.
 */
function parseGitRemoteUrl(remoteUrl: unknown): GitContext | null {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return null;
  }

  const url = remoteUrl.trim();

  // Normalize SSH URLs to HTTPS format for easier parsing
  // git@host:path → https://host/path
  let normalizedUrl = url;
  const sshMatch = /^git@([^:]+):(.+)$/.exec(url);
  if (sshMatch) {
    const host = sshMatch[1];
    const remotePath = sshMatch[2];
    if (host !== undefined && remotePath !== undefined) {
      normalizedUrl = `https://${host}/${remotePath}`;
    }
  }

  // Remove .git suffix if present
  normalizedUrl = normalizedUrl.replace(/\.git$/, '');

  // Azure DevOps: https://dev.azure.com/org/project/_git/repo
  // Azure Legacy: https://org.visualstudio.com/project/_git/repo
  // Azure SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const azureMatch =
    /https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/.exec(normalizedUrl) ||
    /https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/.exec(normalizedUrl) ||
    /https:\/\/ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)/.exec(normalizedUrl);

  if (azureMatch) {
    const orgPart = azureMatch[1];
    const project = azureMatch[2];
    const repo = azureMatch[3];
    if (orgPart === undefined || project === undefined || repo === undefined) {
      return null;
    }
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
  const httpsMatch = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)/.exec(normalizedUrl);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const org = httpsMatch[2];
    const repo = httpsMatch[3];
    if (host === undefined || org === undefined || repo === undefined) {
      return null;
    }

    let provider: HostedGitContext['provider'];
    if (host === 'github.com') {
      provider = 'github';
    } else if (host.includes('gitlab')) {
      provider = 'gitlab';
    } else {
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

function parseFetchRemoteLine(line: string): readonly [string, string] | null {
  // Partial clones append their filter after the fetch marker, for example
  // `origin https://github.com/org/repo.git (fetch) [blob:none]`.
  const fetchMarker = ' (fetch)';
  const fetchMarkerIndex = line.lastIndexOf(fetchMarker);
  if (fetchMarkerIndex < 1) return null;
  const suffix = line.slice(fetchMarkerIndex + fetchMarker.length);
  if (suffix.length > 0 && !(suffix.startsWith(' [') && suffix.endsWith(']'))) return null;

  const remoteLine = line.slice(0, fetchMarkerIndex);
  const separatorIndex = remoteLine.search(/\s/);
  if (separatorIndex < 1) {
    return null;
  }

  const remoteUrl = remoteLine.slice(separatorIndex).trim();
  return remoteUrl.length > 0 ? [remoteLine.slice(0, separatorIndex), remoteUrl] : null;
}

/**
 * Detect git repository context from current working directory.
 * Returns provider context extracted from git remote URL.
 */
function detectGitContext(cwd = process.cwd()): GitContextWithRemote | null {
  try {
    execSync('git rev-parse --git-dir', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch {
    return null;
  }

  try {
    const remoteOutput = execSync('git remote -v', {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    const supportedRemotes = new Map<string, GitContextWithRemote>();
    for (const line of remoteOutput.split(/\r?\n/)) {
      const remoteParts = parseFetchRemoteLine(line);
      if (!remoteParts) {
        continue;
      }

      const [remoteCandidate, remoteUrl] = remoteParts;
      const remote = normalizeGitRemoteName(remoteCandidate);
      if (!remote) {
        continue;
      }
      const context = parseGitRemoteUrl(remoteUrl);
      if (context && !supportedRemotes.has(remote)) {
        supportedRemotes.set(remote, { ...context, remote });
      }
    }

    if (supportedRemotes.has('origin')) {
      return supportedRemotes.get('origin') ?? null;
    }

    if (supportedRemotes.size === 1) {
      return supportedRemotes.values().next().value ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

export = {
  normalizeGitRemoteName,
  quoteShellArgument,
  parseGitRemoteUrl,
  detectGitContext,
};
