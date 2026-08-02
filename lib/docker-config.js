/**
 * Docker mount configuration for isolation mode
 * Fully generic - no hardcoded paths, all configurable
 */

const { listProviderMetadata, getProviderMetadata } = require('./provider-names');
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
      return {
        host: preset.host,
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
 * Validate a provider's fail-closed env/broker auth requirement (registry `docker.envAuth`)
 * against the env vars actually forwarded into the container. Providers with no `envAuth`
 * declared always pass (their auth is validated by mount/credential presence instead).
 * @param {string} providerId
 * @param {Record<string, string|true|undefined>} forwardedEnv - NAME -> value (or `true` as a
 *   presence flag, as used by IsolationManager's forwardedEnv plan) actually forwarded
 * @returns {{ok: true}|{ok: false, message: string}}
 */
function validateProviderEnvAuth(providerId, forwardedEnv) {
  const metadata = getProviderMetadata(providerId);
  const envAuth = metadata.docker && metadata.docker.envAuth;
  if (!envAuth) {
    return { ok: true };
  }

  const isSet = (name) => {
    const value = forwardedEnv ? forwardedEnv[name] : undefined;
    if (value === undefined || value === null || value === false || value === '') {
      return false;
    }
    return true;
  };

  const requireOneOf = envAuth.requireOneOf || [];
  const satisfiedOneOf = requireOneOf.length === 0 || requireOneOf.some(isSet);

  const requireTogether = envAuth.requireTogether || [];
  const partialGroups = requireTogether.filter((group) => {
    const setCount = group.filter(isSet).length;
    return setCount > 0 && setCount < group.length;
  });

  if (satisfiedOneOf && partialGroups.length === 0) {
    return { ok: true };
  }

  const reasons = [];
  if (!satisfiedOneOf) {
    reasons.push(`one of ${requireOneOf.join(', ')} must be set`);
  }
  for (const group of partialGroups) {
    const missing = group.filter((name) => !isSet(name));
    reasons.push(`${group.join(' + ')} must be set together (missing ${missing.join(', ')})`);
  }

  return { ok: false, message: reasons.join('; ') };
}

module.exports = {
  MOUNT_PRESETS,
  ENV_PRESETS,
  PROVIDER_ENV_ONLY_PRESETS,
  resolveMounts,
  resolveEnvs,
  expandEnvPatterns,
  validateMountConfig,
  validateEnvPassthrough,
  validateProviderEnvAuth,
};
