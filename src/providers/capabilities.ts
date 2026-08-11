type ProviderCapabilityState = boolean | 'experimental';
type ProviderCapabilities = Readonly<Record<string, ProviderCapabilityState>>;

interface ProviderNamesFacade {
  readonly PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>>;
  normalizeProviderName(provider: string): string;
  providerSupportsCapability(provider: string, capability: string): boolean;
}

// The generated CommonJS facade resolves the built provider registry through lib/.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { PROVIDER_CAPABILITIES, normalizeProviderName, providerSupportsCapability }:
  ProviderNamesFacade = require('../../lib/provider-names');

const CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_CAPABILITIES).map(([provider, capabilities]) => [
      provider,
      Object.freeze({ ...capabilities }),
    ])
  )
);

function checkCapability(
  provider: string | null | undefined,
  capability: string
): boolean {
  if (!provider) return false;
  return providerSupportsCapability(provider, capability);
}

function warnIfExperimental(provider: string, capability: string): void {
  const normalized = normalizeProviderName(provider);
  const caps = CAPABILITIES[normalized];
  if (caps?.[capability] === 'experimental') {
    console.warn(`⚠️ ${capability} is experimental for ${normalized} and may not work reliably`);
  }
}

export = {
  CAPABILITIES,
  checkCapability,
  warnIfExperimental,
};
