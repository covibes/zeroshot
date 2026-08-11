import { URL } from 'url';

interface ProviderEnvAuth {
  requireOneOf?: readonly string[];
  requireTogether?: readonly (readonly string[])[];
  requireUrl?: readonly string[];
}

interface ProviderMetadata {
  docker?: {
    envAuth?: ProviderEnvAuth;
  };
}

interface ProviderNamesFacade {
  getProviderMetadata(providerId: string): ProviderMetadata;
}

interface ProviderEnvAuthResult {
  ok: boolean;
  satisfiedOneOf: boolean;
  malformed: string[];
  message: string;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');

const ENV_SPEC_PATTERN = /^[A-Z_][A-Z0-9_]*(\*|=.*)?$/i;

function validateEnvPassthrough(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'dockerEnvPassthrough must be an array';
  }

  for (const item of value) {
    if (typeof item !== 'string') {
      return `Invalid env var: ${JSON.stringify(item)}. Must be a string`;
    }
    if (!ENV_SPEC_PATTERN.test(item)) {
      return `Invalid env var spec: "${item}". Use VAR, VAR_*, or VAR=value`;
    }
  }

  return null;
}

function isUsableEnvValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isUsableHttpUrl(value: unknown): boolean {
  if (!isUsableEnvValue(value)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function validateProviderEnvAuth(
  providerId: string,
  forwardedEnv: Readonly<Record<string, string | undefined>> | null | undefined
): ProviderEnvAuthResult {
  const metadata = providerNames.getProviderMetadata(providerId);
  const envAuth = metadata.docker && metadata.docker.envAuth;
  if (!envAuth) {
    return { ok: true, satisfiedOneOf: true, malformed: [], message: '' };
  }

  const requireUrl = new Set(envAuth.requireUrl || []);
  const valueOf = (name: string): string | undefined =>
    forwardedEnv ? forwardedEnv[name] : undefined;
  const isSet = (name: string): boolean =>
    requireUrl.has(name) ? isUsableHttpUrl(valueOf(name)) : isUsableEnvValue(valueOf(name));

  const requireOneOf = envAuth.requireOneOf || [];
  const satisfiedOneOf = requireOneOf.length === 0 || requireOneOf.some(isSet);

  const malformed: string[] = [];
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

export = {
  isUsableEnvValue,
  isUsableHttpUrl,
  validateEnvPassthrough,
  validateProviderEnvAuth,
};
