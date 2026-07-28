import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let helper;
try {
  helper = require('../lib/agent-cli-provider');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Provider helper build missing. Run npm run build:agent-cli-provider. ${message}`
  );
}

export const {
  NO_MESSAGES_RETURNED,
  STREAMING_MODE_ERROR,
  buildProviderCommand,
  classifyProviderError,
  detectProviderFatalError,
  detectProviderStreamingModeError,
  extractProviderSessionId,
  findProviderRegistryEntry,
  getProviderAdapter,
  getProviderRegistryEntry,
  knownProviderNames,
  listProviderAdapters,
  listProviderRegistryEntries,
  normalizeProviderName,
  parseProviderChunk,
  prepareSingleAgentProviderCommand,
  recoverProviderStructuredOutput,
  resolveProviderCommand,
  resolveModelSpec,
  supportsProviderCapability,
  providerAliasMap,
  providerAliases,
  providerIds,
  providerRegistry,
  supportsProviderStructuredOutputRecovery,
} = helper;
