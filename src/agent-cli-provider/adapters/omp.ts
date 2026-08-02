import { contractError } from '../contract-errors';
import { UnsupportedProviderCapabilityError } from '../errors';
import { appendJsonSchemaPrompt } from '../schema';
import { isRecord, unknownToMessage } from '../json';
import { OMP_REMEDIATION, OMP_SUPPORTED_VERSION } from '../omp-release';
import { parseNormalizedOmpRpcEventLine } from '../omp-rpc-events';
import {
  InvalidProviderModelError,
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type OmpCliFeatures,
  type ProviderAdapter,
  type ProviderParseResult,
  type ProviderParserState,
  type ResolvedModelSpec,
  type WarningMetadata,
} from '../types';
import {
  classifyBaseProviderError,
  commandSpec,
  createParserState,
  optionFeatures,
  resolveModelSpecWithConfig,
  warning,
} from './common';

interface OmpConfigOverlay {
  readonly dir: string;
  readonly file: string;
}

type UnknownFunction = (...args: unknown[]) => unknown;

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

function createOmpConfigOverlay(): OmpConfigOverlay {
  const overlayModule: unknown = require('../../../src/omp-config-overlay');
  if (!isRecord(overlayModule) || !isUnknownFunction(overlayModule.createOmpConfigOverlay)) {
    throw new Error('src/omp-config-overlay must export createOmpConfigOverlay.');
  }
  const overlay = overlayModule.createOmpConfigOverlay();
  if (
    !isRecord(overlay) ||
    typeof overlay.dir !== 'string' ||
    typeof overlay.file !== 'string'
  ) {
    throw new Error('createOmpConfigOverlay() must return { dir, file } strings.');
  }
  return { dir: overlay.dir, file: overlay.file };
}

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: '@smol' },
  level2: { rank: 2, model: '@default' },
  level3: { rank: 3, model: '@slow' },
};

// Verified against tagged v17.2.1 source: docs/environment-variables.md ("Model/provider
// authentication", "GitHub/Copilot tokens", "Auth broker", web-search credentials, Bedrock,
// Azure, Vertex sections) plus docs/providers.md's provider/env-var map. This is the full
// official host credential inventory OMP itself resolves credentials from — distinct from
// (and broader than) any narrower automatic Docker env-passthrough allowlist — because OMP
// routes to 70+ downstream model/search providers and every one of their credential env vars
// must be detected and redacted from Zeroshot logs/output, not just the handful Zeroshot's
// own cluster config commonly sets.
const CREDENTIAL_ENV_KEYS: readonly string[] = [
  'AIMLAPI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ALIBABA_CODING_PLAN_API_KEY',
  'ALIBABA_TOKEN_PLAN_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_SEARCH_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_OPENAI_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'BRAVE_API_KEY',
  'CEREBRAS_API_KEY',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'CURSOR_ACCESS_TOKEN',
  'DEEPSEEK_API_KEY',
  'EXA_API_KEY',
  'FIREPASS_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_HUB_TOKEN',
  'JINA_API_KEY',
  'KAGI_API_KEY',
  'KILO_API_KEY',
  'KIMI_SEARCH_API_KEY',
  'LITELLM_API_KEY',
  'LLAMA_CPP_API_KEY',
  'LM_STUDIO_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CODE_API_KEY',
  'MINIMAX_CODE_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'MOONSHOT_SEARCH_API_KEY',
  'NANO_GPT_API_KEY',
  'NOVITA_API_KEY',
  'NVIDIA_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'OMP_AUTH_BROKER_TOKEN',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'PARALLEL_API_KEY',
  'PERPLEXITY_API_KEY',
  'PERPLEXITY_COOKIES',
  'QIANFAN_API_KEY',
  'QWEN_OAUTH_TOKEN',
  'QWEN_PORTAL_API_KEY',
  'SEARXNG_BASIC_PASSWORD',
  'SEARXNG_TOKEN',
  'SILICONFLOW_API_KEY',
  'SILICONFLOW_CN_API_KEY',
  'SMITHERY_API_KEY',
  'SYNTHETIC_API_KEY',
  'TAVILY_API_KEY',
  'TOGETHER_API_KEY',
  'UMANS_AI_CODING_PLAN_API_KEY',
  'VENICE_API_KEY',
  'VLLM_API_KEY',
  'WAFER_SERVERLESS_API_KEY',
  'XAI_API_KEY',
  'XAI_OAUTH_TOKEN',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ZAI_API_KEY',
  'ZENMUX_API_KEY',
  'ZHIPU_API_KEY',
];

const VERSION_TOKEN_PATTERN = /(?<![\w.])17\.2\.1(?![\w.])/;
const MODEL_ID_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function detectCliFeatures(helpText?: string | null, versionText?: string | null): OmpCliFeatures {
  const help = helpText ?? '';
  const version = (versionText ?? '').trim();
  return {
    provider: 'omp',
    versionMatches: VERSION_TOKEN_PATTERN.test(version),
    supportsRpcMode: /(^|\s)rpc(\s|$)/m.test(help),
    supportsConfig: /--config\b/.test(help),
    supportsModel: /--model\b/.test(help),
    supportsThinking: /--thinking\b/.test(help),
    supportsApprovalMode: /--approval-mode\b/.test(help),
    supportsNoTitle: /--no-title\b/.test(help),
    supportsNoSession: /--no-session\b/.test(help),
    supportsSessionDir: /--session-dir\b/.test(help),
    supportsResume: /--resume\b/.test(help),
    unknown: !help,
  };
}

function assertRequiredOmpFeatures(options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  const required: ReadonlyArray<readonly [boolean | undefined, string]> = [
    [features.versionMatches, `exact OMP version ${OMP_SUPPORTED_VERSION}`],
    [features.supportsRpcMode, '"rpc" mode'],
    [features.supportsConfig, '--config'],
    [features.supportsModel, '--model'],
    [features.supportsApprovalMode, '--approval-mode'],
    [features.supportsNoTitle, '--no-title'],
    [features.supportsNoSession, '--no-session'],
  ];
  const missing = required.filter(([supported]) => supported === false).map(([, label]) => label);
  if (missing.length === 0) return;
  throw contractError({
    code: 'unsupported-provider-cli',
    exitCode: 2,
    message:
      `omp CLI is missing required evidence: ${missing.join(', ')}. ${OMP_REMEDIATION} ` +
      'Zeroshot will not silently fall back to Pi or another provider.',
  });
}

function failClosedUnsupportedSessionControl(options: BuildProviderCommandOptions): void {
  const hasResumeSessionId = options.resumeSessionId !== undefined;
  if (!hasResumeSessionId && !options.continueSession) return;
  const field = hasResumeSessionId ? 'options.resumeSessionId' : 'options.continueSession';
  throw contractError({
    code: 'invalid-field',
    field,
    exitCode: 2,
    message:
      'OMP RPC lane runs sessionless (--no-session) in this slice; resume/continue session control is capability-gated off (sessionResume: false).',
  });
}

function rejectMcpConfig(options: BuildProviderCommandOptions): void {
  if (!options.mcpConfig || options.mcpConfig.length === 0) return;
  throw new UnsupportedProviderCapabilityError(
    'omp',
    'mcpServers',
    "OMP does not accept Zeroshot's --mcp-config surface; OMP's own discovered MCP/web tools remain governed by its own harness policy, not translated from Claude/Copilot MCP envelopes."
  );
}

function resolveModelSelector(options: BuildProviderCommandOptions): string {
  const model = options.modelSpec?.model;
  if (typeof model === 'string' && model.length > 0) return model;
  throw contractError({
    code: 'unsupported-provider-cli',
    exitCode: 2,
    message: 'omp requires a resolved --model selector; none was resolved for this run.',
  });
}

function collectWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  if (!options.jsonSchema) return [];
  return [
    warning(
      'omp',
      'omp-jsonschema',
      'OMP CLI does not support provider-native JSON schema; appending schema instructions to the prompt and validating locally.'
    ),
  ];
}

/** Prompt text sent over the RPC `prompt` command — never part of argv for the rpc-stdio lane. */
export function buildOmpPrompt(context: string, options: BuildProviderCommandOptions = {}): string {
  return options.jsonSchema ? appendJsonSchemaPrompt(context, options.jsonSchema) : context;
}

function buildCommand(_context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  assertRequiredOmpFeatures(options);
  failClosedUnsupportedSessionControl(options);
  rejectMcpConfig(options);
  const modelSelector = resolveModelSelector(options);
  const warnings = collectWarnings(options);
  const overlay = createOmpConfigOverlay();

  const args: string[] = ['--mode', 'rpc', '--no-session', '--model', modelSelector];
  if (options.modelSpec?.reasoningEffort) {
    args.push('--thinking', options.modelSpec.reasoningEffort);
  }
  args.push('--approval-mode', 'yolo', '--no-title', '--config', overlay.file);

  return commandSpec({
    binary: 'omp',
    args,
    env: {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    cleanup: [overlay.dir],
    cleanupMetadata: [
      { kind: 'temp-directory', provider: 'omp', path: overlay.dir, reason: 'isolated-config' },
    ],
    warnings,
  });
}

function createOmpState(): ProviderParserState {
  return createParserState('omp');
}

function parseEvent(line: string, state: ProviderParserState): ProviderParseResult {
  return parseNormalizedOmpRpcEventLine(line, state);
}

function resolveModelSpec(level: ModelLevel, overrides?: LevelOverrides): ResolvedModelSpec {
  return resolveModelSpecWithConfig({
    mapping: LEVEL_MAPPING,
    defaultLevel: 'level2',
    level,
    overrides,
    validateModelId,
  });
}

function validateModelId(modelId: string | null | undefined): string | null | undefined {
  if (modelId === undefined || modelId === null) return modelId;
  if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
    throw new InvalidProviderModelError(
      `Invalid model "${unknownToMessage(modelId)}" for provider "omp": must match ${MODEL_ID_PATTERN.source}.`
    );
  }
  return modelId;
}

const OMP_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /\brate(?:[_ -]?limit| limited)\b/i,
  /\bquota\b/i,
  /\bresource[_ -]?exhausted\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\boverloaded\b/i,
  /\bservice unavailable\b/i,
];

const OMP_PERMANENT_PATTERNS: readonly RegExp[] = [
  // Driver stopReason tokens (see omp-rpc-driver.ts) that always indicate a permanent,
  // non-retryable failure: bad binary/protocol/version/limits/selector/config, malformed or
  // over-bound frames, and missing auth/model evidence.
  /\bunsupported-protocol\b/i,
  /\bunsupported-limits\b/i,
  /\bunsupported-provider-cli\b/i,
  /\bunsupported-ui-method\b/i,
  /\bunsupported-capability\b/i,
  /\bunsafe-config\b/i,
  /\bmalformed-response\b/i,
  /\bmalformed-extension-ui-request\b/i,
  /\bmalformed-host-tool-call\b/i,
  /\bmalformed-host-uri-request\b/i,
  /\bextension-error\b/i,
  /\blocal-only-prompt\b/i,
  /\blifetime-request-id-exceeded\b/i,
  /\bpending-request-exceeded\b/i,
  /\bspawn-hook-failed\b/i,
  // Frame decoder codes (omp-rpc-protocol.ts OmpRpcProtocolError.code values) — every one of
  // these means the wire traffic itself is invalid or out-of-bounds, never a transient condition.
  /\bphysical-frame-too-large\b/i,
  /\bmalformed-physical-frame\b/i,
  /\binvalid-chunk-metadata\b/i,
  /\binvalid-chunk-data\b/i,
  /\bchunk-sequence-must-start-at-zero\b/i,
  /\bchunk-sequence-mismatch\b/i,
  /\bchunk-sequence-exceeds-declared-length\b/i,
  /\bchunk-sequence-length-mismatch\b/i,
  /\bmalformed-json-in-reassembled-frame\b/i,
  /\bnon-object-reassembled-frame\b/i,
  /\binvalid-utf8-in-reassembled-frame\b/i,
  /\binflight-reassembly-bytes-exceeded\b/i,
  /\binterleaved-chunk-sequence\b/i,
  /\binterrupted-chunk-sequence\b/i,
  /\bincomplete-physical-frame\b/i,
  /\bincomplete-chunk-sequence\b/i,
  /\boutbound-frame-too-large\b/i,
  /\bpre-negotiation-rpc-chunk\b/i,
  /\b[\w-]+-bound-exceeded\b/i,
  // Auth/model absence and permission/usage errors surfaced verbatim in OMP output.
  /\bno available authenticated\b/i,
  /\bno keyless model\b/i,
  /\bno valid authentication\b/i,
  /\bmissing api key\b/i,
  /\brun\s*\/login\b/i,
  /\bunknown option\b/i,
  /\bfailed to load\b/i,
  /\bcannot find module\b/i,
  /\bno such file or directory\b/i,
];

function classifyError(error: unknown): ErrorClassification {
  const message = unknownToMessage(error);
  if (/\b(cancelled|canceled)\b/i.test(message)) {
    return { retryable: false, kind: 'cancelled' };
  }
  return classifyBaseProviderError(error, OMP_RETRYABLE_PATTERNS, OMP_PERMANENT_PATTERNS);
}

export const ompAdapter: ProviderAdapter = {
  id: 'omp',
  displayName: 'OMP (Oh My Pi)',
  binary: 'omp',
  adapterVersion: '2',
  credentialEnvKeys: CREDENTIAL_ENV_KEYS,
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  parseEvent,
  createParserState: createOmpState,
  resolveModelSpec,
  validateModelId,
  classifyError,
};
