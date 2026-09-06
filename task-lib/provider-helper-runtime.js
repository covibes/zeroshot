import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let helper;
let redactObject;
try {
  helper = require('../lib/agent-cli-provider');
  ({ redactObject } = require('../lib/agent-cli-provider/redaction.js'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Provider helper build missing. Run npm run build:agent-cli-provider. ${message}`
  );
}

export { redactObject };

export const {
  ABORT_GRACE_MS,
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  EXIT_GRACE_MS,
  NO_MESSAGES_RETURNED,
  OMP_SUPPORTED_VERSION,
  STREAMING_MODE_ERROR,
  buildOmpPrompt,
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
  runOmpRpcTask,
  supportsProviderCapability,
  providerAliasMap,
  providerAliases,
  providerIds,
  providerRegistry,
  supportsProviderStructuredOutputRecovery,
} = helper;
