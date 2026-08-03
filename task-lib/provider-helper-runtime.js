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
  ABORT_GRACE_MS,
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  EXIT_GRACE_MS,
  NO_MESSAGES_RETURNED,
  OMP_SUPPORTED_VERSION,
  STREAMING_MODE_ERROR,
  buildOmpPrompt,
  buildProviderCommand,
  classifyProviderError,
  createOmpSdkProtocolCollector,
  decodeOmpSdkSidecarRequest,
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
  spawnOmpSdkProcess,
  supportsProviderCapability,
  providerAliasMap,
  providerAliases,
  providerIds,
  providerRegistry,
  supportsProviderStructuredOutputRecovery,
} = helper;

export function buildAcpPrompt(context, options) {
  const { buildAcpPrompt: buildPrompt } = require('../lib/agent-cli-provider/adapters/acp.js');
  return buildPrompt(context, options);
}

export function runAcpStdioPrompt(provider, commandSpec, prompt, options) {
  const { runAcpStdioPrompt: runPrompt } = require('../lib/agent-cli-provider/acp-stdio-runner.js');
  return runPrompt(provider, commandSpec, prompt, options);
}
