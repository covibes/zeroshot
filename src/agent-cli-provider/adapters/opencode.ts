import { contractError } from '../contract-errors';
import { UnsupportedProviderCapabilityError } from '../errors';
import { appendJsonSchemaPrompt } from '../schema';
import {
  getNumber,
  getOptionalString,
  getRecord,
  getString,
  isRecord,
  tryParseJson,
} from '../json';
import {
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type OpencodeCliFeatures,
  type OutputEvent,
  type ProviderAdapter,
  type WarningMetadata,
} from '../types';
import {
  classifyBaseProviderError,
  commandSpec,
  createParserState,
  isCliVersionAtLeast,
  optionFeatures,
  warning,
} from './common';
import {
  LEVEL_MAPPING,
  MODEL_CATALOG,
  resolveModelSpec,
  validateConfiguredModelId,
  validateModelId,
} from './opencode-models';

function detectCliFeatures(
  helpText?: string | null,
  versionText?: string | null
): OpencodeCliFeatures {
  const help = helpText ?? '';
  const unknown = !help;
  return {
    provider: 'opencode',
    supportsJson: unknown ? true : /--format\b/.test(help),
    supportsModel: unknown ? true : /--model\b/.test(help),
    supportsVariant: unknown ? true : /--variant\b/.test(help),
    supportsDir: unknown ? false : /--dir\b/.test(help),
    supportsCwd: unknown ? false : /--cwd\b/.test(help),
    supportsAutoApprove: false,
    supportsResume: !unknown && /--session\b/.test(help) && /--continue\b/.test(help),
    supportsWebSearch: isCliVersionAtLeast(versionText, '1.0.137'),
    unknown,
  };
}

function addOpencodeOptionalArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (
    (options.outputFormat === 'stream-json' || options.outputFormat === 'json') &&
    features.supportsJson
  ) {
    args.push('--format', 'json');
  }
  if (options.agentName) {
    args.push('--agent', options.agentName);
  }

  if (options.modelSpec?.model) {
    args.push('--model', options.modelSpec.model);
  }

  if (options.modelSpec?.reasoningEffort && features.supportsVariant) {
    args.push('--variant', options.modelSpec.reasoningEffort);
  }

  if (options.cwd && features.supportsDir) {
    args.push('--dir', options.cwd);
  } else if (options.cwd && features.supportsCwd) {
    args.push('--cwd', options.cwd);
  }
}

function collectOpencodeWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  const features = optionFeatures(options);
  const warnings: WarningMetadata[] = [];
  if (options.modelSpec?.reasoningEffort && features.supportsVariant === false) {
    warnings.push(
      warning(
        'opencode',
        'opencode-variant',
        'Opencode CLI does not support --variant; skipping reasoningEffort.'
      )
    );
  }
  return warnings;
}

function addSessionArgs(args: string[], options: BuildProviderCommandOptions): void {
  const hasResumeSessionId = options.resumeSessionId !== undefined;
  if (!hasResumeSessionId && !options.continueSession) return;
  const field = hasResumeSessionId ? 'options.resumeSessionId' : 'options.continueSession';
  if (hasResumeSessionId && options.resumeSessionId?.trim().length === 0) {
    throw contractError({
      code: 'invalid-field',
      field,
      exitCode: 2,
      message: 'options.resumeSessionId must be a non-empty OpenCode session ID.',
    });
  }
  if (optionFeatures(options).supportsResume === false) {
    throw contractError({
      code: 'invalid-field',
      field,
      exitCode: 2,
      message:
        'OpenCode CLI cannot safely run continuation context because this installation lacks run --session/--continue.',
    });
  }
  if (options.resumeSessionId) {
    args.push('--session', options.resumeSessionId);
  } else {
    args.push('--continue');
  }
}

function webSearchEnv(options: BuildProviderCommandOptions): Readonly<Record<string, string>> {
  if (options.webSearch !== true) return {};
  if (optionFeatures(options).supportsWebSearch !== true) {
    throw new UnsupportedProviderCapabilityError(
      'opencode',
      'webSearch',
      'OpenCode web search requires a parseable OpenCode CLI version >= 1.0.137. Update OpenCode or set providerSettings.opencode.webSearch to false.'
    );
  }
  return { OPENCODE_ENABLE_EXA: '1' };
}

function extractSessionId(line: string): string | null {
  const event = tryParseJson(line.trim());
  if (!isRecord(event)) return null;
  const sessionId = getString(event, 'sessionID') ?? getString(event, 'sessionId');
  return sessionId?.trim() || null;
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  const finalContext = options.jsonSchema
    ? appendJsonSchemaPrompt(context, options.jsonSchema)
    : context;
  const args: string[] = ['run'];
  addOpencodeOptionalArgs(args, options);
  addSessionArgs(args, options);

  args.push(finalContext);

  return commandSpec({
    binary: 'opencode',
    args,
    env: webSearchEnv(options),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    warnings: collectOpencodeWarnings(options),
  });
}

function parseToolPart(part: Record<string, unknown>): OutputEvent | null {
  const state = getRecord(part, 'state') ?? {};
  const status = getString(state, 'status');
  if (status === 'pending' || status === 'running') {
    return {
      type: 'tool_call',
      toolName: getOptionalString(part, 'tool'),
      toolId: getOptionalString(part, 'callID'),
      input: state.input ?? {},
    };
  }

  if (status === 'completed') {
    return {
      type: 'tool_result',
      toolId: getOptionalString(part, 'callID'),
      content: state.output || '',
      isError: false,
    };
  }

  if (status === 'error') {
    return {
      type: 'tool_result',
      toolId: getOptionalString(part, 'callID'),
      content: state.error || '',
      isError: true,
    };
  }

  return null;
}

function parseStepFinish(part: Record<string, unknown>): OutputEvent {
  const tokens = getRecord(part, 'tokens') ?? {};
  return {
    type: 'result',
    success: true,
    inputTokens: getNumber(tokens, 'input') ?? 0,
    outputTokens: getNumber(tokens, 'output') ?? 0,
  };
}

function parsePart(part: unknown): OutputEvent | null {
  if (!isRecord(part)) return null;
  if (getString(part, 'type') === 'text') {
    const text = getString(part, 'text');
    if (text) return { type: 'text', text };
  }

  if (getString(part, 'type') === 'reasoning') {
    const text = getString(part, 'text');
    if (text) return { type: 'thinking', text };
  }

  if (getString(part, 'type') === 'tool') {
    return parseToolPart(part);
  }

  if (getString(part, 'type') === 'step-finish') {
    return parseStepFinish(part);
  }

  return null;
}

function parseErrorEvent(event: Record<string, unknown>): OutputEvent {
  const error = getRecord(event, 'error') ?? {};
  const data = getRecord(error, 'data');
  return {
    type: 'result',
    success: false,
    error:
      (data ? getString(data, 'message') : null) ??
      getString(error, 'message') ??
      getString(error, 'name') ??
      'Unknown error',
  };
}

function parseEvent(line: string): OutputEvent | null {
  const event = tryParseJson(line);
  if (!isRecord(event)) return null;

  const type = getString(event, 'type');
  if (type === 'error') return parseErrorEvent(event);
  if (type === 'text' || type === 'step_start' || type === 'step_finish') {
    return parsePart(event.part ?? event);
  }
  if (type === 'message.part.updated') {
    const properties = getRecord(event, 'properties');
    return parsePart(properties?.part);
  }
  return null;
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(error, [], []);
}

export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  displayName: 'Opencode',
  binary: 'opencode',
  adapterVersion: '1',
  credentialEnvKeys: [
    'OPENCODE_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ],
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  extractSessionId,
  parseEvent,
  createParserState: () => createParserState('opencode'),
  resolveModelSpec,
  validateModelId,
  validateConfiguredModelId,
  classifyError,
};
