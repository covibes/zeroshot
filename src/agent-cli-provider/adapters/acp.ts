import { appendJsonSchemaPrompt } from '../schema';
import { snapshotDelta } from '../assistant-stream';
import { contractError } from '../contract-errors';
import {
  getArray,
  getBoolean,
  getNumber,
  getOptionalString,
  getRecord,
  getString,
  isRecord,
  tryParseJson,
} from '../json';
import {
  type AcpCliFeatures,
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type OutputEvent,
  type ProviderAdapter,
  type ProviderId,
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
  validateModelIdFromCatalog,
  warning,
} from './common';

export interface AcpAdapterMetadata {
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  readonly commandArgs: readonly string[];
  readonly credentialEnvKeys: readonly string[];
  readonly modelCatalog?: Readonly<Record<string, ModelCatalogEntry>>;
  readonly levelMapping?: Readonly<Record<ModelLevel, LevelModelSpec>>;
  readonly defaultLevel?: ModelLevel;
  readonly defaultMaxLevel?: ModelLevel;
  readonly defaultMinLevel?: ModelLevel;
  readonly supportsPromptImages: boolean;
  readonly supportsLoadSession: boolean;
  readonly supportsSessionCancel: boolean;
  readonly supportsSessionSetModel: boolean;
  readonly supportsSessionSetMode: boolean;
  readonly retryableErrorPatterns?: readonly RegExp[];
  readonly permanentErrorPatterns?: readonly RegExp[];
}

const DEFAULT_MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {};
const DEFAULT_LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: null },
  level2: { rank: 2, model: null },
  level3: { rank: 3, model: null },
};

function detectCliFeatures(meta: AcpAdapterMetadata, helpText?: string | null): AcpCliFeatures {
  const help = helpText ?? '';
  const unknown = !help;
  return {
    provider: meta.provider,
    supportsAcpStdio: unknown ? true : /\bacp\b/.test(help),
    supportsPromptImages: meta.supportsPromptImages,
    supportsLoadSession: meta.supportsLoadSession,
    supportsSessionCancel: meta.supportsSessionCancel,
    supportsSessionSetModel: meta.supportsSessionSetModel,
    supportsSessionSetMode: meta.supportsSessionSetMode,
    supportsRemoteTransport: false,
    supportsCustomTransport: false,
    supportsPermissionRequests: false,
    supportsFsTools: false,
    supportsTerminalTools: false,
    unknown,
  };
}

function failClosedUnsupportedSessionControl(
  provider: ProviderId,
  options: BuildProviderCommandOptions
): void {
  const hasResumeSessionId = options.resumeSessionId !== undefined;
  if (!hasResumeSessionId && !options.continueSession) return;
  const field = hasResumeSessionId ? 'options.resumeSessionId' : 'options.continueSession';
  throw contractError({
    code: 'invalid-field',
    field,
    exitCode: 2,
    message: `${provider} ACP stdio adapter only supports fresh headless sessions; resume/continue is capability-gated off.`,
  });
}

function failClosedUnsupportedAcpStdio(
  meta: AcpAdapterMetadata,
  options: BuildProviderCommandOptions
): void {
  if (optionFeatures(options).supportsAcpStdio !== false) return;
  throw contractError({
    code: 'invalid-field',
    field: 'options.cliFeatures.supportsAcpStdio',
    exitCode: 2,
    message: `${meta.displayName} CLI does not advertise ACP stdio support; fail closed instead of launching the unsupported ACP lane.`,
  });
}

function collectWarnings(
  meta: AcpAdapterMetadata,
  options: BuildProviderCommandOptions
): WarningMetadata[] {
  const warnings: WarningMetadata[] = [];
  if (options.autoApprove) {
    warnings.push(
      warning(
        meta.provider,
        'acp-auto-approve',
        `${meta.displayName} ACP stdio does not support interactive approval callbacks; failing closed if the agent requests one.`
      )
    );
  }
  if (options.jsonSchema) {
    warnings.push(
      warning(
        meta.provider,
        'acp-jsonschema',
        `${meta.displayName} ACP stdio has no provider-native JSON schema lane; schema instructions are appended to the prompt.`
      )
    );
  }
  return warnings;
}

function buildCommand(
  meta: AcpAdapterMetadata,
  _context: string,
  options: BuildProviderCommandOptions = {}
): CommandSpec {
  failClosedUnsupportedAcpStdio(meta, options);
  failClosedUnsupportedSessionControl(meta.provider, options);
  return commandSpec({
    binary: meta.binary,
    args: [...meta.commandArgs],
    env: {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    warnings: collectWarnings(meta, options),
  });
}

export function buildAcpPrompt(context: string, options: BuildProviderCommandOptions = {}): string {
  return options.jsonSchema ? appendJsonSchemaPrompt(context, options.jsonSchema) : context;
}

function createAcpState(provider: ProviderId): ProviderParserState {
  return {
    ...createParserState(provider),
    lastAssistantText: '',
    lastAssistantThinking: '',
    assistantTextByMessageId: new Map(),
    assistantThinkingByMessageId: new Map(),
    toolCalls: new Map(),
    usage: null,
  };
}

function textSnapshots(state: ProviderParserState): Map<string, string> {
  if (!state.assistantTextByMessageId) state.assistantTextByMessageId = new Map();
  return state.assistantTextByMessageId;
}

function thinkingSnapshots(state: ProviderParserState): Map<string, string> {
  if (!state.assistantThinkingByMessageId) state.assistantThinkingByMessageId = new Map();
  return state.assistantThinkingByMessageId;
}

function toolCalls(
  state: ProviderParserState
): Map<string, { name: string | null | undefined; input: unknown }> {
  if (!state.toolCalls) state.toolCalls = new Map();
  return state.toolCalls;
}

function resolveChunkSnapshot(previous: string, chunk: string): string {
  if (!previous) return chunk;
  if (!chunk || previous === chunk) return previous;
  if (chunk.startsWith(previous)) return chunk;
  if (previous.startsWith(chunk)) return chunk;
  return previous + chunk;
}

function joinTextBlocks(content: unknown, allowedTypes: readonly string[]): string | null {
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : [content];
  let value = '';
  let matched = false;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = getString(block, 'type');
    if (type !== null && !allowedTypes.includes(type)) continue;
    const text = getOptionalString(block, 'text') ?? getOptionalString(block, 'thinking');
    if (text === null) continue;
    value += text;
    matched = true;
  }
  return matched ? value : null;
}

function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input ?? {};
  const parsed = tryParseJson(input);
  return parsed ?? input;
}

function normalizeToolContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const text = content
    .map((item) => (isRecord(item) ? getString(item, 'text') : null))
    .filter((value): value is string => typeof value === 'string')
    .join('');
  return text || content;
}

function updateUsage(state: ProviderParserState, update: Record<string, unknown>): void {
  const usage = getRecord(update, 'usage') ?? update;
  const inputTokens = getNumber(usage, 'inputTokens');
  const outputTokens = getNumber(usage, 'outputTokens');
  const cacheReadInputTokens = getNumber(usage, 'cacheReadInputTokens');
  const cacheCreationInputTokens = getNumber(usage, 'cacheCreationInputTokens');
  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadInputTokens === null &&
    cacheCreationInputTokens === null
  ) {
    return;
  }
  state.usage = {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(cacheReadInputTokens === null ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === null ? {} : { cacheCreationInputTokens }),
  };
}

function parseAssistantChunk(
  update: Record<string, unknown>,
  state: ProviderParserState,
  options: {
    readonly textTypes?: readonly string[];
    readonly thinkingTypes?: readonly string[];
  }
): readonly OutputEvent[] {
  const messageId = getOptionalString(update, 'messageId') ?? 'assistant';
  const content = update.content ?? getArray(update, 'content');
  const textByMessageId = textSnapshots(state);
  const thinkingByMessageId = thinkingSnapshots(state);
  const nextText = options.textTypes ? joinTextBlocks(content, options.textTypes) : null;
  const nextThinking = options.thinkingTypes
    ? joinTextBlocks(content, options.thinkingTypes)
    : null;

  const events: OutputEvent[] = [];
  if (nextText !== null) {
    const previousText = textByMessageId.get(messageId) ?? '';
    const currentText = resolveChunkSnapshot(previousText, nextText);
    const textDelta = snapshotDelta(previousText, currentText);
    textByMessageId.set(messageId, currentText);
    if (currentText) state.lastAssistantText = currentText;
    if (textDelta) events.push({ type: 'text', text: textDelta });
  }
  if (nextThinking !== null) {
    const previousThinking = thinkingByMessageId.get(messageId) ?? '';
    const currentThinking = resolveChunkSnapshot(previousThinking, nextThinking);
    const thinkingDelta = snapshotDelta(previousThinking, currentThinking);
    thinkingByMessageId.set(messageId, currentThinking);
    if (currentThinking) state.lastAssistantThinking = currentThinking;
    if (thinkingDelta) events.push({ type: 'thinking', text: thinkingDelta });
  }
  return events;
}

function parseToolCall(
  update: Record<string, unknown>,
  state: ProviderParserState
): OutputEvent | null {
  const toolId =
    getOptionalString(update, 'toolCallId') ??
    getOptionalString(update, 'toolId') ??
    getOptionalString(update, 'id');
  if (!toolId) return null;
  const toolName =
    getOptionalString(update, 'title') ??
    getOptionalString(update, 'toolName') ??
    getOptionalString(update, 'name');
  const input = normalizeToolInput(update.rawInput ?? update.input ?? update.arguments ?? {});
  state.lastToolId = toolId;
  toolCalls(state).set(toolId, { name: toolName, input });
  return {
    type: 'tool_call',
    toolName,
    toolId,
    input,
  };
}

function parseToolCallUpdate(
  update: Record<string, unknown>,
  state: ProviderParserState
): OutputEvent | null {
  const toolId =
    getOptionalString(update, 'toolCallId') ??
    getOptionalString(update, 'toolId') ??
    getOptionalString(update, 'id') ??
    state.lastToolId;
  if (!toolId) return null;
  state.lastToolId = toolId;
  const content =
    update.rawOutput ?? update.output ?? update.partialResult ?? update.content ?? update.result;
  if (content === undefined) return null;
  const status = getOptionalString(update, 'status');
  const isError = getBoolean(update, 'isError') ?? (status === 'failed' || status === 'cancelled');
  return {
    type: 'tool_result',
    toolId,
    content: normalizeToolContent(content),
    isError,
  };
}

function resultFromStopReason(
  state: ProviderParserState,
  response: Record<string, unknown>
): OutputEvent {
  updateUsage(state, response);
  const stopReason =
    getOptionalString(response, 'stopReason') ?? getOptionalString(response, 'stop_reason');
  const explicitError =
    getOptionalString(response, 'error') ??
    getOptionalString(response, 'errorMessage') ??
    getOptionalString(response, 'message');
  const success = stopReason !== 'cancelled' && stopReason !== 'refusal';
  const resultText =
    typeof state.lastAssistantText === 'string' && state.lastAssistantText.length > 0
      ? state.lastAssistantText
      : null;
  return {
    type: 'result',
    success,
    result: success ? resultText : null,
    error: success ? null : (explicitError ?? stopReason ?? 'ACP prompt failed.'),
    ...(state.usage?.inputTokens === undefined ? {} : { inputTokens: state.usage.inputTokens }),
    ...(state.usage?.outputTokens === undefined ? {} : { outputTokens: state.usage.outputTokens }),
    ...(state.usage?.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: state.usage.cacheReadInputTokens }),
    ...(state.usage?.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: state.usage.cacheCreationInputTokens }),
    cost: null,
    modelUsage: state.usage,
  };
}

function resultFromRpcError(error: Record<string, unknown>): OutputEvent {
  return {
    type: 'result',
    success: false,
    result: null,
    error: getString(error, 'message') ?? 'ACP request failed.',
  };
}

function parseSessionUpdate(
  params: Record<string, unknown>,
  state: ProviderParserState
): ProviderParseResult {
  const update = getRecord(params, 'update') ?? params;
  const sessionUpdate =
    getOptionalString(update, 'sessionUpdate') ??
    getOptionalString(update, 'session_update') ??
    getOptionalString(update, 'type');
  if (!sessionUpdate || sessionUpdate.startsWith('_')) return null;
  if (sessionUpdate === 'agent_message_chunk') {
    return parseAssistantChunk(update, state, {
      textTypes: ['text'],
      thinkingTypes: ['thinking'],
    });
  }
  if (sessionUpdate === 'agent_thought_chunk') {
    return parseAssistantChunk(update, state, {
      thinkingTypes: ['thinking', 'text'],
    });
  }
  if (sessionUpdate === 'tool_call') return parseToolCall(update, state);
  if (sessionUpdate === 'tool_call_update') return parseToolCallUpdate(update, state);
  if (sessionUpdate === 'usage_update') {
    updateUsage(state, update);
    return null;
  }
  return null;
}

function parseRpcObject(
  parsed: Record<string, unknown>,
  state: ProviderParserState
): ProviderParseResult {
  const method = getOptionalString(parsed, 'method');
  if (method === 'session/update') {
    const params = getRecord(parsed, 'params') ?? {};
    return parseSessionUpdate(params, state);
  }
  if (method?.startsWith('_')) return null;
  if (parsed.error && isRecord(parsed.error)) return resultFromRpcError(parsed.error);
  const result = getRecord(parsed, 'result');
  if (!result) return null;
  if (getOptionalString(result, 'stopReason') || getOptionalString(result, 'stop_reason')) {
    return resultFromStopReason(state, result);
  }
  return null;
}

function parseEvent(
  line: string,
  state: ProviderParserState
): OutputEvent | readonly OutputEvent[] | null {
  const parsed = tryParseJson(line);
  if (!isRecord(parsed)) return null;
  return parseRpcObject(parsed, state);
}

function resolveModelSpec(
  meta: AcpAdapterMetadata,
  level: ModelLevel,
  overrides?: LevelOverrides
): ResolvedModelSpec {
  const mapping = meta.levelMapping ?? DEFAULT_LEVEL_MAPPING;
  return resolveModelSpecWithConfig({
    mapping,
    defaultLevel: meta.defaultLevel ?? 'level2',
    level,
    overrides,
    validateModelId: (modelId) => validateModelId(meta, modelId),
  });
}

function validateModelId(
  meta: AcpAdapterMetadata,
  modelId: string | null | undefined
): string | null | undefined {
  return validateModelIdFromCatalog(
    meta.provider,
    meta.modelCatalog ?? DEFAULT_MODEL_CATALOG,
    modelId
  );
}

function classifyError(meta: AcpAdapterMetadata, error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    meta.retryableErrorPatterns ?? [],
    meta.permanentErrorPatterns ?? []
  );
}

export function createAcpAdapter(meta: AcpAdapterMetadata): ProviderAdapter {
  return {
    id: meta.provider,
    displayName: meta.displayName,
    binary: meta.binary,
    adapterVersion: '1',
    credentialEnvKeys: meta.credentialEnvKeys,
    modelCatalog: meta.modelCatalog ?? DEFAULT_MODEL_CATALOG,
    levelMapping: meta.levelMapping ?? DEFAULT_LEVEL_MAPPING,
    defaultLevel: meta.defaultLevel ?? 'level2',
    defaultMaxLevel: meta.defaultMaxLevel ?? 'level3',
    defaultMinLevel: meta.defaultMinLevel ?? 'level1',
    detectCliFeatures: (helpText) => detectCliFeatures(meta, helpText),
    buildCommand: (context, options) => buildCommand(meta, context, options),
    parseEvent,
    createParserState: () => createAcpState(meta.provider),
    resolveModelSpec: (level, overrides) => resolveModelSpec(meta, level, overrides),
    validateModelId: (modelId) => validateModelId(meta, modelId),
    classifyError: (error) => classifyError(meta, error),
  };
}
