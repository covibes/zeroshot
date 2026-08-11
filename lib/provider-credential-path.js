const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function expandProviderCredentialPath(value, env = process.env) {
  const homeExpanded = expandHome(value);
  if (homeExpanded !== value) return homeExpanded;
  const variable = value.match(/^\$([A-Z_][A-Z0-9_]*)(\/.*)?$/);
  if (!variable) return value;
  const root = env[variable[1]];
  return typeof root === 'string' && root.trim()
    ? path.resolve(expandHome(root), `.${variable[2] || ''}`)
    : null;
}

function resolveProviderCredentialPaths(metadata, env = process.env) {
  const overrideName = metadata.docker?.mount?.hostEnv;
  const overrideSet =
    typeof overrideName === 'string' &&
    typeof env[overrideName] === 'string' &&
    env[overrideName].trim();
  const candidates = overrideName
    ? metadata.credentialPaths.filter((value) =>
        overrideSet ? value.startsWith(`$${overrideName}/`) : !value.startsWith(`$${overrideName}/`)
      )
    : metadata.credentialPaths;
  return candidates
    .map((value) => expandProviderCredentialPath(value, env))
    .filter((value) => value !== null);
}

module.exports = { expandProviderCredentialPath, resolveProviderCredentialPaths };
