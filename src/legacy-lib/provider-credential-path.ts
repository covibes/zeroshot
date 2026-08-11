import os = require('node:os');
import path = require('node:path');

type Environment = Readonly<Record<string, string | undefined>>;

interface ProviderCredentialMetadata {
  readonly credentialPaths: readonly string[];
  readonly docker?: {
    readonly mount?: {
      readonly hostEnv?: unknown;
    };
  };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function expandProviderCredentialPath(
  value: string,
  env: Environment = process.env
): string | null {
  const homeExpanded = expandHome(value);
  if (homeExpanded !== value) return homeExpanded;
  const variable = /^\$([A-Z_][A-Z0-9_]*)(\/.*)?$/.exec(value);
  if (!variable) return value;
  const variableName = variable[1];
  if (!variableName) return value;
  const root = env[variableName];
  return typeof root === 'string' && root.trim()
    ? path.resolve(expandHome(root), `.${variable[2] || ''}`)
    : null;
}

function resolveProviderCredentialPaths(
  metadata: ProviderCredentialMetadata,
  env: Environment = process.env
): string[] {
  const overrideName = metadata.docker?.mount?.hostEnv;
  const overrideSet =
    typeof overrideName === 'string' &&
    typeof env[overrideName] === 'string' &&
    env[overrideName].trim();
  const candidates = overrideName
    ? metadata.credentialPaths.filter((value) =>
        overrideSet
          ? value.startsWith(`$${overrideName}/`)
          : !value.startsWith(`$${overrideName}/`)
      )
    : metadata.credentialPaths;
  return candidates
    .map((value) => expandProviderCredentialPath(value, env))
    .filter((value): value is string => value !== null);
}

export = { expandProviderCredentialPath, resolveProviderCredentialPaths };
