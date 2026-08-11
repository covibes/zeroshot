type ProviderCapabilityState = boolean | 'experimental';
type ProviderCapabilities = Readonly<Record<string, ProviderCapabilityState>>;

interface ProviderRegistryEntry {
  readonly capabilities: ProviderCapabilities;
  readonly docker: {
    readonly envPassthrough: readonly string[];
  };
  readonly id: string;
  readonly [key: string]: unknown;
}

interface ProviderRegistryFacade {
  getDefaultProviderId(): string;
  getProviderRegistryEntry(name: string): ProviderRegistryEntry;
  knownProviderNames: readonly string[];
  listProviderRegistryEntries(): readonly ProviderRegistryEntry[];
  normalizeProviderName(name: string): string;
  providerAliasMap: Readonly<Record<string, string>>;
  providerIds: readonly string[];
  resolveProviderCommand(name: string): {
    readonly args: readonly string[];
    readonly command: string;
  };
  supportsProviderCapability(name: string, capability: string): boolean;
  supportsProviderOutputReformatting(name: string): boolean;
}

// The emitted CommonJS facade resolves the built registry beside this module.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const registry: ProviderRegistryFacade = require('./agent-cli-provider/provider-registry');

const VALID_PROVIDERS = [...registry.providerIds];
const KNOWN_PROVIDER_NAMES = [...registry.knownProviderNames];
const PROVIDER_ALIASES = Object.freeze({ ...registry.providerAliasMap });
const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = Object.freeze(
  Object.fromEntries(
    registry.listProviderRegistryEntries().map((entry) => [entry.id, entry.capabilities])
  )
);

// Non-string legacy inputs intentionally pass through unchanged.
// eslint-disable-next-line sonarjs/function-return-type
function normalizeProviderName<T>(name: T): T | string {
  if (!name || typeof name !== 'string') return name;
  return registry.normalizeProviderName(name);
}

// Non-record legacy settings intentionally pass through unchanged.
// eslint-disable-next-line sonarjs/function-return-type
function normalizeProviderSettings<T>(providerSettings: T): T | Record<string, unknown> {
  if (
    !providerSettings ||
    typeof providerSettings !== 'object' ||
    Array.isArray(providerSettings)
  ) {
    return providerSettings;
  }

  const normalized: Record<string, unknown> = {};
  const entries = Object.entries(providerSettings);
  entries.sort(([left], [right]) => {
    const leftIsCanonical = normalizeProviderName(left) === left;
    const rightIsCanonical = normalizeProviderName(right) === right;
    if (leftIsCanonical === rightIsCanonical) return 0;
    return leftIsCanonical ? 1 : -1;
  });
  const aliasFirst = entries;

  for (const [key, value] of aliasFirst) {
    const canonical = normalizeProviderName(key);
    if (!VALID_PROVIDERS.includes(canonical)) {
      normalized[key] = value;
      continue;
    }
    // Preserve JavaScript object-spread coercion for malformed legacy values.
    normalized[canonical] = {
      ...Object(normalized[canonical] || {}),
      ...Object(value || {}),
    };
  }

  return normalized;
}

function getProviderMetadata(name: string): ProviderRegistryEntry {
  return registry.getProviderRegistryEntry(name);
}

function listProviderMetadata(): readonly ProviderRegistryEntry[] {
  return registry.listProviderRegistryEntries();
}

function resolveProviderCommand(name: string): {
  readonly args: readonly string[];
  readonly command: string;
} {
  return registry.resolveProviderCommand(name);
}

function providerSupportsCapability(name: string, capability: string): boolean {
  return registry.supportsProviderCapability(name, capability);
}

function providerSupportsOutputReformatting(name: string): boolean {
  return registry.supportsProviderOutputReformatting(name);
}

function getDefaultProviderId(): string {
  return registry.getDefaultProviderId();
}

export = {
  KNOWN_PROVIDER_NAMES,
  PROVIDER_ALIASES,
  PROVIDER_CAPABILITIES,
  VALID_PROVIDERS,
  getDefaultProviderId,
  getProviderMetadata,
  listProviderMetadata,
  normalizeProviderName,
  normalizeProviderSettings,
  providerSupportsCapability,
  providerSupportsOutputReformatting,
  resolveProviderCommand,
};
