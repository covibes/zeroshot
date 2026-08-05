const fs = require('fs');
const os = require('os');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const { commandExists, getCommandPath } = require('../../lib/provider-detection');
const { getProviderMetadata, resolveProviderCommand } = require('../../lib/provider-names');
const { execSync } = require('../../src/lib/safe-exec');

function safeExec(command, cwd) {
  try {
    return execSync(command, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function probeGit() {
  const cwd = workerData.payload.cwd || process.cwd();
  const isRepo = safeExec('git rev-parse --is-inside-work-tree', cwd) === 'true';
  if (!isRepo) {
    return { isRepo: false, branch: null, remote: null, defaultBranch: null, clean: null };
  }
  const defaultRef = safeExec('git rev-parse --abbrev-ref origin/HEAD', cwd);
  return {
    isRepo: true,
    branch: safeExec('git rev-parse --abbrev-ref HEAD', cwd),
    remote: safeExec('git remote get-url origin', cwd),
    defaultBranch: defaultRef ? defaultRef.replace(/^origin\//, '') : null,
    clean: safeExec('git status --porcelain', cwd) === null,
  };
}

function probeDocker() {
  const { checkDocker } = require('../../src/preflight');
  return checkDocker();
}

function probeIssue() {
  const { checkGhAuth } = require('../../src/preflight');
  return checkGhAuth();
}

function expandCredentialPath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function hasCredentialEvidence(metadata) {
  const hasEnvironment = metadata.credentialEnvKeys.some((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (hasEnvironment) return true;
  return metadata.credentialPaths.some((item) => fs.existsSync(expandCredentialPath(item)));
}

function providerAuthStatus(id, metadata, available) {
  if (!available) return { authStatus: 'unknown', authReason: null };
  if (id === 'gateway') return { authStatus: 'ready', authReason: null };
  if (id === 'claude') {
    const { checkClaudeAuth } = require('../../src/preflight');
    const auth = checkClaudeAuth();
    return auth.authenticated
      ? { authStatus: 'ready', authReason: null }
      : { authStatus: 'login-required', authReason: auth.error || 'authentication not found' };
  }
  return hasCredentialEvidence(metadata)
    ? { authStatus: 'ready', authReason: null }
    : { authStatus: 'login-required', authReason: metadata.authInstructions };
}

function probeProvider() {
  const id = workerData.payload.id;
  const metadata = getProviderMetadata(id);
  const { command } = resolveProviderCommand(id);
  const commandAvailable = commandExists(command);
  let available = false;
  let error = null;
  try {
    const { getProvider } = require('../../src/providers');
    available = getProvider(id).isAvailable() === true;
  } catch (probeError) {
    error = probeError.message;
  }
  const auth = providerAuthStatus(id, metadata, available);
  return {
    id,
    available,
    commandAvailable,
    command,
    path: available ? getCommandPath(command) : null,
    displayName: metadata.displayName,
    authStatus: auth.authStatus,
    authReason: auth.authReason,
    error,
  };
}

function runProbe() {
  switch (workerData.kind) {
    case 'git':
      return probeGit();
    case 'docker':
      return probeDocker();
    case 'issue':
      return probeIssue();
    case 'provider':
      return probeProvider();
    default:
      throw new Error(`Unknown setup probe: ${workerData.kind}`);
  }
}

try {
  parentPort.postMessage({ ok: true, result: runProbe() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
