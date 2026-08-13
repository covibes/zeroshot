import { getProviderRegistryEntry } from '../provider-registry';
import type { PreparedEnvironmentPolicy } from '../types';

const MINIMAL_ENV_NAMES = [
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TZ',
] as const;

const ALLOWED_ENV_NAMES = new Set([
  ...MINIMAL_ENV_NAMES,
  ...(getProviderRegistryEntry('omp').configurationEnvKeys ?? []),
]);

export function isOmpSdkEnvironmentName(name: string): boolean {
  return ALLOWED_ENV_NAMES.has(name.toUpperCase());
}

export function ompSdkEnvironmentPolicy(
  environment: NodeJS.ProcessEnv = process.env
): PreparedEnvironmentPolicy {
  const values: Record<string, string> = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = environment[name];
    if (value !== undefined) values[name] = value;
  }
  return {
    inherit: 'minimal',
    values: Object.freeze(values),
  };
}
