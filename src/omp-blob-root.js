// Resolution of OMP's *shared* content-addressed blob store root, mirrored from the tagged
// v17.2.1 source (`packages/utils/src/dirs.ts`: `getBlobsDir()` / `DirResolver`) rather than
// invented by Zeroshot.
//
// Why this exists: OMP externalizes large payloads (images, provider data URLs) out of the session
// JSONL into `<blobsDir>/<sha256-hex>` and leaves a nested `blob:sha256:<hex>` reference string
// inside the JSONL record (`packages/coding-agent/src/session/blob-store.ts`). The store is shared
// by every session on the machine and lives at `~/.omp/agent/blobs` by default — nowhere near
// Zeroshot's per-task session partition. A resumed partition whose referenced blobs are missing is
// an invalid continuation, so verification has to resolve them at this real root; and because the
// root is shared, Zeroshot cleanup must never delete anything under it.
//
// Resolution order, exactly as `DirResolver`'s constructor computes it:
//   profile      = normalize(OMP_PROFILE ?? PI_PROFILE)         // OMP_PROFILE wins; '' selects default
//   configRoot   = ~/${PI_CONFIG_DIR || '.omp'}[/profiles/<profile>]
//   defaultAgent = <configRoot>/agent
//   agentDir     = profile ? defaultAgent : (resolve(PI_CODING_AGENT_DIR) || defaultAgent)
//   dataBase     = (linux|darwin) && agentDir === defaultAgent && $XDG_DATA_HOME/omp[/profiles/<p>]
//                  exists ? that : agentDir                      // XDG flattens the agent/ prefix
//   blobsDir     = <dataBase>/blobs
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'omp';
const CONFIG_DIR_NAME = '.omp';
// dirs.ts PROFILE_NAME_RE / WINDOWS_RESERVED_BASENAME_RE.
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

/** dirs.ts normalizeProfileName, but total: an invalid name resolves to the default profile here
 * instead of throwing. A resume against a profile OMP itself would reject cannot succeed anyway —
 * the verifier will simply not find the referenced blobs and fail the continuation closed. */
function normalizeProfileName(profile) {
  const normalized = typeof profile === 'string' ? profile.trim() : '';
  if (!normalized || normalized === 'default') return undefined;
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.endsWith('.') ||
    !PROFILE_NAME_PATTERN.test(normalized) ||
    WINDOWS_RESERVED_BASENAME_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function activeProfile(env) {
  return normalizeProfileName(
    env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  );
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Absolute path of the shared OMP blob store for the current environment.
 * `env`/`homedir`/`platform` are injectable for tests only; production callers pass nothing.
 */
function resolveOmpBlobsDir({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
} = {}) {
  const profile = activeProfile(env);
  const configDirName = env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
  const baseConfigRoot = path.join(homedir, configDirName);
  const configRoot = profile ? path.join(baseConfigRoot, 'profiles', profile) : baseConfigRoot;

  const defaultAgentDir = path.join(configRoot, 'agent');
  // A named profile pins the agent dir to the profile root; PI_CODING_AGENT_DIR applies only in
  // default mode (dirs.ts: `const agentDirOverride = profile ? undefined : options.agentDirOverride`).
  const agentDirOverride = profile ? undefined : env.PI_CODING_AGENT_DIR;
  const agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgentDir;

  let dataBase = agentDir;
  if ((platform === 'linux' || platform === 'darwin') && agentDir === defaultAgentDir) {
    const xdgDataHome = env.XDG_DATA_HOME;
    if (xdgDataHome) {
      const appRoot = path.join(xdgDataHome, APP_NAME);
      const candidate = profile ? path.join(appRoot, 'profiles', profile) : appRoot;
      if (directoryExists(candidate)) dataBase = candidate;
    }
  }

  return path.join(dataBase, 'blobs');
}

/** True when `candidate` is the shared blob root or anything inside it. Cleanup uses this as a
 * hard stop: a Zeroshot partition must never resolve into OMP's shared, cross-session CAS. */
function isInsideOmpBlobsDir(candidate, options = {}) {
  const blobsDir = resolveOmpBlobsDir(options);
  const resolved = path.resolve(candidate);
  return resolved === blobsDir || resolved.startsWith(blobsDir + path.sep);
}

module.exports = {
  APP_NAME,
  CONFIG_DIR_NAME,
  isInsideOmpBlobsDir,
  normalizeProfileName,
  resolveOmpBlobsDir,
};
