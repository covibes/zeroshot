interface MountPreset {
  host: string;
  container: string;
  readonly: boolean;
  hostEnv?: string;
}

interface ProviderDockerConfig {
  envPassthrough: readonly string[];
  mount?: MountPreset;
}

interface ProviderMetadata {
  docker: ProviderDockerConfig;
  id: string;
}

interface ProviderNamesFacade {
  listProviderMetadata(): readonly ProviderMetadata[];
}

interface CredentialPathFacade {
  expandProviderCredentialPath(pathValue: string): string;
}

interface ProviderEnvAuthResult {
  ok: boolean;
  satisfiedOneOf: boolean;
  malformed: string[];
  message: string;
}

interface DockerEnvAuthFacade {
  isUsableEnvValue(value: unknown): value is string;
  isUsableHttpUrl(value: unknown): boolean;
  validateEnvPassthrough(value: unknown): string | null;
  validateProviderEnvAuth(
    providerId: string,
    forwardedEnv: Readonly<Record<string, string | undefined>> | null | undefined
  ): ProviderEnvAuthResult;
}

interface CustomMount {
  host?: string;
  container?: string;
  readonly?: boolean;
}

interface ResolvedMount {
  host: string;
  container: string;
  readonly: boolean;
}

interface ResolveMountOptions {
  containerHome?: string;
}

interface ExpandedEnv {
  name: string;
  value: string | null;
  forced: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const credentialPaths: CredentialPathFacade = require('./provider-credential-path');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const dockerEnvAuth: DockerEnvAuthFacade = require('./docker-env-auth');

const { listProviderMetadata } = providerNames;
const { expandProviderCredentialPath } = credentialPaths;
const {
  isUsableEnvValue,
  isUsableHttpUrl,
  validateEnvPassthrough,
  validateProviderEnvAuth,
} = dockerEnvAuth;

const BASE_MOUNT_PRESETS: Readonly<Record<string, MountPreset>> = {
  gh: { host: '~/.config/gh', container: '$HOME/.config/gh', readonly: false },
  git: { host: '~/.gitconfig', container: '$HOME/.gitconfig', readonly: true },
  ssh: { host: '~/.ssh', container: '$HOME/.ssh', readonly: true },
  aws: { host: '~/.aws', container: '$HOME/.aws', readonly: true },
  azure: { host: '~/.azure', container: '$HOME/.azure', readonly: true },
  kube: { host: '~/.kube', container: '$HOME/.kube', readonly: true },
  terraform: { host: '~/.terraform.d', container: '$HOME/.terraform.d', readonly: false },
  gcloud: { host: '~/.config/gcloud', container: '$HOME/.config/gcloud', readonly: true },
};

const BASE_ENV_PRESETS: Readonly<Record<string, readonly string[]>> = {
  aws: ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_PAGER='],
  azure: ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'],
  gcloud: ['CLOUDSDK_CORE_PROJECT', 'GOOGLE_CLOUD_PROJECT'],
  kube: ['KUBECONFIG'],
  terraform: ['TF_VAR_*'],
};

function listProviderDockerPresetEntries(): Array<readonly [string, ProviderDockerConfig]> {
  return listProviderMetadata().map((metadata) => [metadata.id, metadata.docker]);
}

function listProviderMountEntries(): Array<readonly [string, MountPreset]> {
  const entries: Array<readonly [string, MountPreset]> = [];
  for (const [providerId, docker] of listProviderDockerPresetEntries()) {
    if (docker.mount) {
      entries.push([providerId, docker.mount]);
    }
  }
  return entries;
}

const MOUNT_PRESETS: Readonly<Record<string, MountPreset>> = Object.freeze({
  ...BASE_MOUNT_PRESETS,
  ...Object.fromEntries(listProviderMountEntries()),
});

const ENV_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...BASE_ENV_PRESETS,
  ...Object.fromEntries(
    listProviderDockerPresetEntries().map(([providerId, docker]) => [
      providerId,
      [...docker.envPassthrough],
    ])
  ),
});

const PROVIDER_ENV_ONLY_PRESETS: ReadonlySet<string> = Object.freeze(
  new Set(
    listProviderDockerPresetEntries()
      .filter(([, docker]) => !docker.mount && docker.envPassthrough.length > 0)
      .map(([providerId]) => providerId)
  )
);

function isCustomMount(value: unknown): value is CustomMount {
  return typeof value === 'object' && value !== null;
}

function resolveMountItem(item: unknown, containerHome: string): ResolvedMount[] {
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
    return [
      {
        host: overriddenHost,
        container: preset.container.replace(/\$HOME/g, containerHome),
        readonly: preset.readonly,
      },
    ];
  }

  if (isCustomMount(item)) {
    if (!item.host || !item.container) {
      throw new Error('Custom mount must have "host" and "container" properties');
    }
    return [
      {
        host: item.host,
        container: item.container.replace(/\$HOME/g, containerHome),
        readonly: item.readonly !== false,
      },
    ];
  }

  throw new Error(
    `Invalid mount config: ${JSON.stringify(item)}. Use preset name or {host, container, readonly?}`
  );
}

function resolveMounts(config: unknown, options: ResolveMountOptions = {}): ResolvedMount[] {
  if (!Array.isArray(config)) {
    throw new Error('dockerMounts must be an array');
  }

  const containerHome = options.containerHome || '/root';
  return config.flatMap((item: unknown) => resolveMountItem(item, containerHome));
}

function resolveEnvs(mountConfig: readonly unknown[], extraEnvs: readonly string[] = []): string[] {
  const envs = new Set(extraEnvs);

  for (const item of mountConfig) {
    if (typeof item === 'string') {
      const preset = ENV_PRESETS[item];
      if (preset) {
        for (const envVar of preset) {
          envs.add(envVar);
        }
      }
    }
  }

  return [...envs];
}

function expandEnvPatterns(
  envVars: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): ExpandedEnv[] {
  const result: ExpandedEnv[] = [];

  for (const envVar of envVars) {
    if (envVar.includes('=')) {
      const separator = envVar.indexOf('=');
      result.push({
        name: envVar.slice(0, separator),
        value: envVar.slice(separator + 1),
        forced: true,
      });
    } else if (envVar.endsWith('*')) {
      const prefix = envVar.slice(0, -1);
      for (const key of Object.keys(env)) {
        if (key.startsWith(prefix)) {
          result.push({ name: key, value: null, forced: false });
        }
      }
    } else {
      result.push({ name: envVar, value: null, forced: false });
    }
  }

  return result;
}

function validateMountConfig(value: unknown): string | null {
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
    } else if (isCustomMount(item)) {
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

export = {
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
