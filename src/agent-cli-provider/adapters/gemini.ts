import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UnsupportedProviderCapabilityError } from '../errors';
import { appendJsonSchemaPrompt } from '../schema';
import {
  getOrStringFromKeys,
  getOrStringFromKeysWithFallback,
  getString,
  isRecord,
  tryParseJson,
} from '../json';
import {
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type GeminiCliFeatures,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type OutputEvent,
  type StructuredOutputRecoveryAdapter,
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
  unsupportedSessionControlWarnings,
  validateModelIdFromCatalog,
  warning,
} from './common';

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  'gemini-2.5-pro': { rank: 3 },
  'gemini-2.0-flash': { rank: 1 },
};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: null },
  level2: { rank: 2, model: null },
  level3: { rank: 3, model: null },
};

function detectCliFeatures(helpText?: string | null): GeminiCliFeatures {
  const help = helpText ?? '';
  const unknown = !help;
  return {
    provider: 'gemini',
    supportsStreamJson: unknown ? true : /--output-format\b/.test(help),
    supportsAutoApprove: unknown ? true : /--yolo\b/.test(help),
    supportsCwd: unknown ? true : /--cwd\b/.test(help),
    supportsModel: unknown ? true : /\s-m\b/.test(help) || /--model\b/.test(help),
    supportsAdminPolicy: !unknown && /--admin-policy\b/.test(help),
    unknown,
  };
}

function addGeminiOptionalArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (
    (options.outputFormat === 'stream-json' || options.outputFormat === 'json') &&
    features.supportsStreamJson
  ) {
    args.push('--output-format', 'stream-json');
  }

  if (options.modelSpec?.model) {
    args.push('-m', options.modelSpec.model);
  }

  if (options.cwd && features.supportsCwd) {
    args.push('--cwd', options.cwd);
  }

  if (options.autoApprove && features.supportsAutoApprove) {
    args.push('--yolo');
  }
}

function collectGeminiWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  const features = optionFeatures(options);
  const warnings: WarningMetadata[] = unsupportedSessionControlWarnings('gemini', options);
  if (options.autoApprove && features.supportsAutoApprove === false) {
    warnings.push(
      warning(
        'gemini',
        'gemini-auto-approve',
        'Gemini CLI does not support --yolo; continuing without auto-approve.'
      )
    );
  }
  return warnings;
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  const finalContext = options.jsonSchema
    ? appendJsonSchemaPrompt(context, options.jsonSchema)
    : context;
  const args: string[] = ['-p', finalContext];
  addGeminiOptionalArgs(args, options);

  return commandSpec({
    binary: 'gemini',
    args,
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    warnings: collectGeminiWarnings(options),
  });
}

function standardAdminPolicyDirectory(): string {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/GeminiCli/policies';
  }
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'gemini-cli', 'policies');
  }
  return '/etc/gemini-cli/policies';
}

function assertSupplementalAdminPolicyEffective(): void {
  const directory = standardAdminPolicyDirectory();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw new UnsupportedProviderCapabilityError(
      'gemini',
      'structuredOutputRecovery',
      `Gemini structured-output recovery cannot inspect the standard admin-policy directory ${directory}; refuse a supplemental policy that may be ignored.`
    );
  }
  if (!entries.some((entry) => entry.isFile() && entry.name.endsWith('.toml'))) return;
  throw new UnsupportedProviderCapabilityError(
    'gemini',
    'structuredOutputRecovery',
    `Gemini ignores --admin-policy when ${directory} contains TOML policies. Remove the conflict or use an administrator-managed deny-all policy before retrying.`
  );
}

function writeRecoveryAdminPolicy(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gemini-policy-'));
  const policyPath = path.join(directory, `${randomUUID()}.toml`);
  fs.writeFileSync(policyPath, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return policyPath;
}

function buildStructuredOutputRecoveryCommand(
  context: string,
  options: BuildProviderCommandOptions = {}
): CommandSpec {
  if (optionFeatures(options).supportsAdminPolicy !== true) {
    throw new UnsupportedProviderCapabilityError(
      'gemini',
      'structuredOutputRecovery',
      'Gemini structured-output recovery requires CLI evidence for --admin-policy. Upgrade @google/gemini-cli before retrying.'
    );
  }
  assertSupplementalAdminPolicyEffective();
  const recoveryOptions = { ...options };
  delete recoveryOptions.resumeSessionId;
  delete recoveryOptions.continueSession;
  const spec = buildCommand(context, { ...recoveryOptions, autoApprove: false });
  const policyPath = writeRecoveryAdminPolicy();
  return {
    ...spec,
    args: ['--admin-policy', policyPath, ...spec.args],
    cleanup: [...(spec.cleanup || []), policyPath],
    cleanupMetadata: [
      ...spec.cleanupMetadata,
      { kind: 'temp-file', provider: 'gemini', path: policyPath, reason: 'admin-policy' },
    ],
  };
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item)) return getString(item, 'text') ?? '';
        return '';
      })
      .join('');
  }
  if (isRecord(content)) return getString(content, 'text') ?? '';
  return '';
}

function parseMessageEvent(event: Record<string, unknown>): OutputEvent | null {
  if (getString(event, 'role') !== 'assistant') return null;
  const text = normalizeMessageContent(event.content);
  return text ? { type: 'text', text } : null;
}

function parseToolUseEvent(
  event: Record<string, unknown>,
  state: ProviderParserState
): OutputEvent {
  const toolId = getOrStringFromKeysWithFallback(
    event,
    ['tool_call_id', 'tool_id', 'id'],
    state.lastToolId
  );
  state.lastToolId = toolId;
  return {
    type: 'tool_call',
    toolName: getOrStringFromKeys(event, ['tool_name', 'name']),
    toolId,
    input: event.parameters ?? event.input ?? {},
  };
}

function geminiErrorMessage(event: Record<string, unknown>, fallback: string): string {
  const error = isRecord(event.error) ? event.error : null;
  return (error && getString(error, 'message')) || getString(event, 'message') || fallback;
}

function parseToolResultEvent(
  event: Record<string, unknown>,
  state: ProviderParserState
): OutputEvent {
  const toolId = getOrStringFromKeysWithFallback(
    event,
    ['tool_call_id', 'tool_id', 'id'],
    state.lastToolId
  );
  const isError = getString(event, 'status') === 'error';
  return {
    type: 'tool_result',
    toolId,
    content: event.output ?? (isError ? geminiErrorMessage(event, 'Tool failed') : ''),
    isError,
  };
}

function parseResultEvent(event: Record<string, unknown>): OutputEvent {
  const success = getString(event, 'status') === 'success';
  return {
    type: 'result',
    success,
    result: event.result || '',
    error: success ? null : geminiErrorMessage(event, 'Result failed'),
  };
}

function parseErrorEvent(event: Record<string, unknown>): OutputEvent | null {
  if (getString(event, 'severity') !== 'error') return null;
  return {
    type: 'result',
    success: false,
    result: '',
    error: getString(event, 'message') || 'Gemini CLI error',
  };
}

function parseEvent(line: string, state: ProviderParserState): OutputEvent | null {
  const event = tryParseJson(line);
  if (!isRecord(event)) return null;

  switch (getString(event, 'type')) {
    case 'init':
      return null;
    case 'message':
      return parseMessageEvent(event);
    case 'tool_use':
      return parseToolUseEvent(event, state);
    case 'tool_result':
      return parseToolResultEvent(event, state);
    case 'result':
      return parseResultEvent(event);
    case 'error':
      return parseErrorEvent(event);
    default:
      return null;
  }
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
  return validateModelIdFromCatalog('gemini', MODEL_CATALOG, modelId);
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    [
      /\bRESOURCE_EXHAUSTED\b/i,
      /\bUNAVAILABLE\b/i,
      /\bDEADLINE_EXCEEDED\b/i,
      /No capacity available/i,
      /quota.?exceeded/i,
    ],
    [
      /\bINVALID_ARGUMENT\b/i,
      /\bPERMISSION_DENIED\b/i,
      /\bNOT_FOUND\b/i,
      /\bIneligibleTierError\b/i,
      /\bUNSUPPORTED_CLIENT\b/i,
      /\bno longer supported\b/i,
    ]
  );
}

export const geminiAdapter: StructuredOutputRecoveryAdapter = {
  id: 'gemini',
  displayName: 'Gemini',
  binary: 'gemini',
  adapterVersion: '1',
  credentialEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  buildStructuredOutputRecoveryCommand,
  parseEvent,
  createParserState: () => createParserState('gemini'),
  resolveModelSpec,
  validateModelId,
  classifyError,
};
