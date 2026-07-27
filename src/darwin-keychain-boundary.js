/**
 * Darwin worker Keychain boundary (issue #704).
 *
 * Non-interactive local/worktree workers are spawned with the host environment,
 * so worker descendants (e.g. `claude doctor` probing Keychain writes through
 * `security -i`) reach the logged-in user's GUI Keychain session and launch
 * SecurityAgent dialogs from a supposedly non-interactive cluster.
 *
 * On darwin, worker spawn envs get a managed shim directory prepended to PATH
 * containing a `security` wrapper that fails closed on interactive invocations
 * (`-i`, `-p`, or no arguments) with a deterministic diagnostic, and execs the
 * real /usr/bin/security for every other subcommand so provider authentication
 * (e.g. `security find-generic-password`) keeps working.
 *
 * Docker isolation never reaches this code path, and non-darwin platforms are
 * left untouched. Set ZEROSHOT_ALLOW_INTERACTIVE_KEYCHAIN=1 to opt out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SHIM_DIR_RELATIVE_PATH = path.join('.zeroshot', 'keychain-shim');
const REAL_SECURITY_PATH = '/usr/bin/security';
const OPT_OUT_ENV_VAR = 'ZEROSHOT_ALLOW_INTERACTIVE_KEYCHAIN';

function pathKeyForEnv(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildSecurityShimScript(realSecurityPath) {
  return `#!/bin/sh
# Managed by Zeroshot (src/darwin-keychain-boundary.js). Do not edit.
#
# Non-interactive Zeroshot workers must not open the logged-in user's GUI
# Keychain session (SecurityAgent). Interactive \`security\` invocations fail
# closed here; every other subcommand is passed through to the real binary so
# provider authentication keeps working.

REAL_SECURITY=${shellQuote(realSecurityPath)}

if [ "\${${OPT_OUT_ENV_VAR}:-0}" = "1" ]; then
  exec "$REAL_SECURITY" "$@"
fi

fail_closed() {
  echo "zeroshot: blocked interactive 'security' invocation from a non-interactive worker (argv: $*)." >&2
  echo "zeroshot: this cluster has no interactive Keychain session, so SecurityAgent prompts are disabled." >&2
  echo "zeroshot: run the cluster with Docker isolation or configure explicit credentials for the tool that attempted Keychain access." >&2
  echo "zeroshot: set ${OPT_OUT_ENV_VAR}=1 to restore interactive Keychain access." >&2
  exit 1
}

# \`security\` without arguments enters interactive mode.
[ "$#" -eq 0 ] && fail_closed

# Global options precede the subcommand. -i (interactive) and -p (prompt,
# implies -i) must not reach the real binary; option letters may be bundled
# (e.g. -qi). Scanning stops at the first non-option token (the subcommand).
for arg in "$@"; do
  case "$arg" in
    -*i*|-*p*) fail_closed "$@" ;;
    -*) ;;
    *) break ;;
  esac
done

exec "$REAL_SECURITY" "$@"
`;
}

/**
 * Create (or refresh) the managed shim directory containing the `security`
 * wrapper. Idempotent: the script is only rewritten when its content changes.
 *
 * @param {object} [options]
 * @param {string} [options.shimBaseDir] - Shim directory (tests only); defaults to ~/.zeroshot/keychain-shim.
 * @param {string} [options.realSecurityPath] - Real binary to exec (tests only); defaults to /usr/bin/security.
 * @returns {string} Absolute path of the shim directory.
 */
function ensureDarwinKeychainShimDir(options = {}) {
  const shimDir = options.shimBaseDir || path.join(os.homedir(), SHIM_DIR_RELATIVE_PATH);
  const script = buildSecurityShimScript(options.realSecurityPath || REAL_SECURITY_PATH);
  const shimPath = path.join(shimDir, 'security');

  fs.mkdirSync(shimDir, { recursive: true });

  let existing = null;
  try {
    existing = fs.readFileSync(shimPath, 'utf8');
  } catch {
    // Missing or unreadable: (re)write below.
  }
  if (existing !== script) {
    fs.writeFileSync(shimPath, script, { mode: 0o755 });
  }
  // writeFileSync's mode only applies on creation; enforce it unconditionally.
  fs.chmodSync(shimPath, 0o755);

  return shimDir;
}

/**
 * Prepend the Keychain boundary shim to a worker spawn env's PATH.
 *
 * No-op off darwin and when the operator opted out via
 * ZEROSHOT_ALLOW_INTERACTIVE_KEYCHAIN=1. Fails closed (throws) when the shim
 * cannot be installed: spawning the worker anyway would silently re-expose the
 * interactive Keychain session.
 *
 * @param {object} env - Spawn env to mutate (also returned).
 * @param {object} [options]
 * @param {string} [options.platform] - Platform override (tests only).
 * @param {string} [options.shimBaseDir] - See ensureDarwinKeychainShimDir.
 * @param {string} [options.realSecurityPath] - See ensureDarwinKeychainShimDir.
 * @returns {object} The same env object.
 */
function applyDarwinKeychainBoundaryToEnv(env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return env;
  }
  if (env[OPT_OUT_ENV_VAR] === '1' || process.env[OPT_OUT_ENV_VAR] === '1') {
    return env;
  }

  let shimDir;
  try {
    shimDir = ensureDarwinKeychainShimDir(options);
  } catch (error) {
    throw new Error(
      `Failed to install the darwin Keychain boundary shim: ${error.message}. ` +
        `Non-interactive workers must not reach the interactive Keychain session; ` +
        `use Docker isolation or set ${OPT_OUT_ENV_VAR}=1 to opt out.`
    );
  }

  const pathKey = pathKeyForEnv(env);
  const existingEntries = (env[pathKey] || '')
    .split(path.delimiter)
    .filter((entry) => entry && entry !== shimDir);
  env[pathKey] = [shimDir, ...existingEntries].join(path.delimiter);
  return env;
}

module.exports = {
  applyDarwinKeychainBoundaryToEnv,
  ensureDarwinKeychainShimDir,
};
