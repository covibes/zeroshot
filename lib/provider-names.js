const registry = require('./agent-cli-provider/provider-registry');

const VALID_PROVIDERS = [...registry.providerIds];
const KNOWN_PROVIDER_NAMES = [...registry.knownProviderNames];
const PROVIDER_ALIASES = Object.freeze({ ...registry.providerAliasMap });
const PROVIDER_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    registry.listProviderRegistryEntries().map((entry) => [entry.id, entry.capabilities])
  )
);

function normalizeProviderName(name) {
  if (!name || typeof name !== 'string') return name;
  return registry.normalizeProviderName(name);
}

function normalizeProviderSettings(providerSettings) {
  if (
    !providerSettings ||
    typeof providerSettings !== 'object' ||
    Array.isArray(providerSettings)
  ) {
    return providerSettings;
  }

  const normalized = {};
  const entries = Object.entries(providerSettings);
  const aliasFirst = entries.sort(([left], [right]) => {
    const leftIsCanonical = normalizeProviderName(left) === left;
    const rightIsCanonical = normalizeProviderName(right) === right;
    if (leftIsCanonical === rightIsCanonical) return 0;
    return leftIsCanonical ? 1 : -1;
  });

  for (const [key, value] of aliasFirst) {
    const canonical = normalizeProviderName(key);
    if (!VALID_PROVIDERS.includes(canonical)) {
      normalized[key] = value;
      continue;
    }
    normalized[canonical] = {
      ...(normalized[canonical] || {}),
      ...(value || {}),
    };
  }

  return normalized;
}

function getProviderMetadata(name) {
  return registry.getProviderRegistryEntry(name);
}

function listProviderMetadata() {
  return registry.listProviderRegistryEntries();
}

function resolveProviderCommand(name) {
  return registry.resolveProviderCommand(name);
}

function providerSupportsCapability(name, capability) {
  return registry.supportsProviderCapability(name, capability);
}

function providerSupportsOutputReformatting(name) {
  return registry.supportsProviderOutputReformatting(name);
}

module.exports = {
  KNOWN_PROVIDER_NAMES,
  PROVIDER_ALIASES,
  PROVIDER_CAPABILITIES,
  VALID_PROVIDERS,
  getProviderMetadata,
  listProviderMetadata,
  normalizeProviderName,
  normalizeProviderSettings,
  providerSupportsCapability,
  providerSupportsOutputReformatting,
  resolveProviderCommand,
};
