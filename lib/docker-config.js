/**
 * Docker mount configuration for isolation mode
 * Fully generic - no hardcoded paths, all configurable
 */

const { URL } = require('url');
const { listProviderMetadata, getProviderMetadata } = require('./provider-names');
const { expandProviderCredentialPath } = require('./provider-credential-path');
/**
 * Built-in mount presets
 * Uses $HOME placeholder - resolved at runtime based on dockerContainerHome setting
 * Host paths use ~ (expanded to host user's home)
 * Container paths use $HOME (expanded to configured container home)
 */
const BASE_MOUNT_PRESETS = {
  gh: { host: '~/.config/gh', container: '$HOME/.config/gh', readonly: false },
  git: { host: '~/.gitconfig', container: '$HOME/.gitconfig', readonly: true },
  ssh: { host: '~/.ssh', container: '$HOME/.ssh', readonly: true },
  aws: { host: '~/.aws', container: '$HOME/.aws', readonly: true },
  azure: { host: '~/.azure', container: '$HOME/.azure', readonly: true },
  kube: { host: '~/.kube', container: '$HOME/.kube', readonly: true },
  terraform: { host: '~/.terraform.d', container: '$HOME/.terraform.d', readonly: false },
  gcloud: { host: '~/.config/gcloud', container: '$HOME/.config/gcloud', readonly: true },
};

/**
 * Environment variables to auto-pass for each preset
 * Supports:
 * - Simple: 'VAR_NAME' (pass if set in host env)
 * - Pattern: 'VAR_*' (pass all matching vars)
 * - Forced: 'VAR=value' (always set to value)
 * - Empty: 'VAR=' (always set to empty string)
 */
const BASE_ENV_PRESETS = {
  aws: ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_PAGER='],
  azure: ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'],
  gcloud: ['CLOUDSDK_CORE_PROJECT', 'GOOGLE_CLOUD_PROJECT'],
  kube: ['KUBECONFIG'],
  terraform: ['TF_VAR_*'],
};

function listProviderDockerPresetEntries() {
  return listProviderMetadata().map((metadata) => [metadata.id, metadata.docker]);
}

const MOUNT_PRESETS = Object.freeze({
  ...BASE_MOUNT_PRESETS,
  ...Object.fromEntries(
    listProviderDockerPresetEntries()
      .filter(([, docker]) => docker.mount)
      .map(([providerId, docker]) => [providerId, docker.mount])
  ),
});

const ENV_PRESETS = Object.freeze({
  ...BASE_ENV_PRESETS,
  ...Object.fromEntries(
    listProviderDockerPresetEntries().map(([providerId, docker]) => [
      providerId,
      [...docker.envPassthrough],
    ])
  ),
});

// Providers that declare an envPassthrough preset but no automatic mount (e.g. omp: env/broker
// auth only, zero automatic credential mounts). `resolveMounts` treats these as a valid preset
// that resolves to no mount specs, rather than an unknown-preset error.
const PROVIDER_ENV_ONLY_PRESETS = Object.freeze(
  new Set(
    listProviderDockerPresetEntries()
      .filter(([, docker]) => !docker.mount && docker.envPassthrough.length > 0)
      .map(([providerId]) => providerId)
  )
);

/**
 * Resolve mount config to actual mount specs
 * @param {Array<string|object>} config - Preset names or {host, container, readonly?} objects
 * @param {object} options - Resolution options
 * @param {string} [options.containerHome='/root'] - Container home directory for $HOME expansion
 * @returns {Array<{host: string, container: string, readonly: boolean}>}
 */
function resolveMounts(config, options = {}) {
  if (!Array.isArray(config)) {
    throw new Error('dockerMounts must be an array');
  }

  const containerHome = options.containerHome || '/root';

  return config.flatMap((item) => {
    if (typeof item === 'string') {
      const preset = MOUNT_PRESETS[item];
      if (!preset) {
        if (PROVIDER_ENV_ONLY_PRESETS.has(item)) {
          return [];
        }
        throw new Error(
          `Unknown mount preset: "${item}". Valid presets: ${Object.keys(MOUNT_PRESETS).join(', ')}. ` +
            `Env-only presets (no mount): ${[...PROVIDER_ENV_ONLY_PRESETS].join(', ')}`
        );
      }
      const overriddenHost =
        typeof preset.hostEnv === 'string' && process.env[preset.hostEnv]?.trim()
          ? expandProviderCredentialPath(`$${preset.hostEnv}`)
          : preset.host;
      return {
        host: overriddenHost,
        container: preset.container.replace(/\$HOME/g, containerHome),
        readonly: preset.readonly,
      };
    }

    if (typeof item === 'object' && item !== null) {
      if (!item.host || !item.container) {
        throw new Error('Custom mount must have "host" and "container" properties');
      }
      return {
        host: item.host,
        container: item.container.replace(/\$HOME/g, containerHome),
        readonly: item.readonly !== false,
      };
    }

    throw new Error(
      `Invalid mount config: ${JSON.stringify(item)}. Use preset name or {host, container, readonly?}`
    );
  });
}

/**
 * Resolve env vars to pass based on enabled presets + explicit additions
 * @param {Array<string|object>} mountConfig - The mount config (to detect presets)
 * @param {Array<string>} extraEnvs - Additional env vars to pass
 * @returns {Array<string>} - List of env var specs
 */
function resolveEnvs(mountConfig, extraEnvs = []) {
  const envs = new Set(extraEnvs);

  for (const item of mountConfig) {
    if (typeof item === 'string' && ENV_PRESETS[item]) {
      for (const envVar of ENV_PRESETS[item]) {
        envs.add(envVar);
      }
    }
  }

  return [...envs];
}

/**
 * Expand env var patterns and resolve values
 * Supports:
 * - Simple: 'VAR_NAME' (use value from env if set)
 * - Pattern: 'VAR_*' (expand to all matching vars)
 * - Forced: 'VAR=value' (always set to value)
 * - Empty: 'VAR=' (always set to empty string)
 *
 * @param {Array<string>} envVars - List of env var specs
 * @param {object} env - Environment object (defaults to process.env)
 * @returns {Array<{name: string, value: string|null, forced: boolean}>}
 */
function expandEnvPatterns(envVars, env = process.env) {
  const result = [];

  for (const envVar of envVars) {
    // Forced value: VAR=value or VAR=
    if (envVar.includes('=')) {
      const [name, ...valueParts] = envVar.split('=');
      const value = valueParts.join('=');
      result.push({ name, value, forced: true });
    }
    // Pattern: VAR_*
    else if (envVar.endsWith('*')) {
      const prefix = envVar.slice(0, -1);
      for (const key of Object.keys(env)) {
        if (key.startsWith(prefix)) {
          result.push({ name: key, value: null, forced: false });
        }
      }
    }
    // Simple: VAR_NAME
    else {
      result.push({ name: envVar, value: null, forced: false });
    }
  }

  return result;
}

/**
 * Validate mount config
 * @param {unknown} value - Value to validate
 * @returns {string|null} - Error message if invalid, null if valid
 */
function validateMountConfig(value) {
  if (!Array.isArray(value)) {
    return 'dockerMounts must be an array';
  }

  for (const item of value) {
    if (typeof item === 'string') {
      if (!MOUNT_PRESETS[item] && !PROVIDER_ENV_ONLY_PRESETS.has(item)) {
        return (
          `Unknown mount preset: "${item}". Valid: ${Object.keys(MOUNT_PRESETS).join(', ')}. ` +
          `Env-only presets (no mount): ${[...PROVIDER_ENV_ONLY_PRESETS].join(', ')}`
        );
      }
    } else if (typeof item === 'object' && item !== null) {
      if (!item.host) {
        return 'Custom mount missing "host" property';
      }
      if (!item.container) {
        return 'Custom mount missing "container" property';
      }
      if (item.readonly !== undefined && typeof item.readonly !== 'boolean') {
        return '"readonly" must be a boolean';
      }
    } else {
      return `Invalid mount: ${JSON.stringify(item)}. Use preset name or {host, container, readonly?}`;
    }
  }

  return null;
}

/**
 * Validate env passthrough config
 * @param {unknown} value - Value to validate
 * @returns {string|null} - Error message if invalid, null if valid
 */
function validateEnvPassthrough(value) {
  if (!Array.isArray(value)) {
    return 'dockerEnvPassthrough must be an array';
  }

  for (const item of value) {
    if (typeof item !== 'string') {
      return `Invalid env var: ${JSON.stringify(item)}. Must be a string`;
    }
    // Allow: VAR, VAR_*, VAR=value, VAR=
    if (!/^[A-Z_][A-Z0-9_]*(\*|=.*)?$/i.test(item)) {
      return `Invalid env var spec: "${item}". Use VAR, VAR_*, or VAR=value`;
    }
  }

  return null;
}

/**
 * A credential env var counts as present only when the container would actually receive a
 * usable value. An absent, non-string, empty, or whitespace-only value is NOT a credential —
 * `dockerEnvPassthrough: ["OPENAI_API_KEY="]` forces an empty value into `docker run -e`, which
 * would otherwise read as "authenticated" while the CLI inside the container has nothing to use.
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableEnvValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A broker/base-URL env var is usable only when it parses as an absolute http(s) URL. Anything
 * else (a bare host, a `file:` URL, a token pasted into the URL slot) fails closed rather than
 * being handed to the provider to blow up on inside the container.
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableHttpUrl(value) {
  if (!isUsableEnvValue(value)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Validate a provider's fail-closed env/broker auth requirement (registry `docker.envAuth`)
 * against the env vars actually forwarded into the container, using their ACTUAL values (a
 * presence flag cannot distinguish a real key from a forced-empty one). Providers with no
 * `envAuth` declared always pass (their auth is validated by mount/credential presence instead).
 *
 * Never includes a value in its output — only variable NAMES.
 *
 * @param {string} providerId
 * @param {Record<string, string|undefined>} forwardedEnv - NAME -> the exact value the container
 *   would receive
 * @returns {{ok: boolean, satisfiedOneOf: boolean, malformed: string[], message: string}}
 *   `satisfiedOneOf` reports whether an *automatic allowlist* credential is usable; `malformed`
 *   lists hard plan defects (partial required pair, unusable URL) that no other credential can
 *   compensate for. `ok` is the combination of both.
 */
function validateProviderEnvAuth(providerId, forwardedEnv) {
  const metadata = getProviderMetadata(providerId);
  const envAuth = metadata.docker && metadata.docker.envAuth;
  if (!envAuth) {
    return { ok: true, satisfiedOneOf: true, malformed: [], message: '' };
  }

  const requireUrl = new Set(envAuth.requireUrl || []);
  const valueOf = (name) => (forwardedEnv ? forwardedEnv[name] : undefined);
  // A URL-shaped var counts as "set" only when it is a usable http(s) URL; a malformed one is
  // reported separately below so the remediation says "malformed", not "missing".
  const isSet = (name) =>
    requireUrl.has(name) ? isUsableHttpUrl(valueOf(name)) : isUsableEnvValue(valueOf(name));

  const requireOneOf = envAuth.requireOneOf || [];
  const satisfiedOneOf = requireOneOf.length === 0 || requireOneOf.some(isSet);

  const malformed = [];
  for (const name of requireUrl) {
    if (isUsableEnvValue(valueOf(name)) && !isUsableHttpUrl(valueOf(name))) {
      malformed.push(`${name} is set but is not a usable http(s) URL`);
    }
  }

  for (const group of envAuth.requireTogether || []) {
    const missing = group.filter((name) => !isSet(name));
    if (missing.length > 0 && missing.length < group.length) {
      malformed.push(`${group.join(' + ')} must be set together (missing ${missing.join(', ')})`);
    }
  }

  const reasons = [...malformed];
  if (!satisfiedOneOf) {
    reasons.push(`one of ${requireOneOf.join(', ')} must be set to a non-empty value`);
  }

  return {
    ok: malformed.length === 0 && satisfiedOneOf,
    satisfiedOneOf,
    malformed,
    message: reasons.join('; '),
  };
}

module.exports = {
  MOUNT_PRESETS,
  ENV_PRESETS,
  PROVIDER_ENV_ONLY_PRESETS,
  resolveMounts,
  resolveEnvs,
  expandEnvPatterns,
  isUsableEnvValue,
  isUsableHttpUrl,
  validateMountConfig,
  validateEnvPassthrough,
  validateProviderEnvAuth,
};
