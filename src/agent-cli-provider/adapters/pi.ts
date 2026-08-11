import { appendJsonSchemaPrompt } from '../schema';
import { contractError } from '../contract-errors';
import { unknownToMessage } from '../json';
import { PI_CREDENTIAL_ENV_KEYS } from '../pi/credentials';
import { createPiParserState, finishPiParsing, parsePiEvent } from '../pi/events';
import { PI_SUPPORTED_VERSION } from '../pi/release';
import {
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type PiCliFeatures,
  type ProviderAdapter,
  type ResolvedModelSpec,
  type WarningMetadata,
} from '../types';
import {
  classifyBaseProviderError,
  commandSpec,
  isCliVersionAtLeast,
  optionFeatures,
  resolveModelSpecWithConfig,
  warning,
} from './common';

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: null, reasoningEffort: 'low' },
  level2: { rank: 2, model: null, reasoningEffort: 'medium' },
  level3: { rank: 3, model: null, reasoningEffort: 'high' },
};

function supportsFlag(
  help: string,
  assumeCurrent: boolean,
  versionMatches: boolean,
  pattern: RegExp
): boolean {
  return versionMatches && (assumeCurrent || pattern.test(help));
}

function detectCliFeatures(helpText?: string | null, versionText?: string | null): PiCliFeatures {
  const help = helpText ?? '';
  const versionMatches = isCliVersionAtLeast(versionText, PI_SUPPORTED_VERSION);
  const assumeCurrent = !help && versionMatches;
  return {
    provider: 'pi',
    versionMatches,
    supportsJsonMode:
      supportsFlag(help, assumeCurrent, versionMatches, /--mode\b/) &&
      (assumeCurrent || /\bjson\b/.test(help)),
    supportsModel: supportsFlag(help, assumeCurrent, versionMatches, /--model\b/),
    supportsThinking: supportsFlag(help, assumeCurrent, versionMatches, /--thinking\b/),
    supportsNoSession: supportsFlag(help, assumeCurrent, versionMatches, /--no-session\b/),
    supportsNoExtensions: supportsFlag(help, assumeCurrent, versionMatches, /--no-extensions\b/),
    supportsNoSkills: supportsFlag(help, assumeCurrent, versionMatches, /--no-skills\b/),
    supportsNoPromptTemplates: supportsFlag(
      help,
      assumeCurrent,
      versionMatches,
      /--no-prompt-templates\b/
    ),
    supportsNoContextFiles: supportsFlag(
      help,
      assumeCurrent,
      versionMatches,
      /--no-context-files\b/
    ),
    supportsNoApprove: supportsFlag(help, assumeCurrent, versionMatches, /--no-approve\b/),
    unknown: !help || !(versionText ?? '').trim(),
  };
}

function assertRequiredControls(options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (features.versionMatches !== true) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.cliFeatures.versionMatches',
      exitCode: 2,
      message:
        `Pi ${PI_SUPPORTED_VERSION} or newer is required for the agent_settled JSON protocol. ` +
        `Upgrade with: npm install -g --ignore-scripts ` +
        `@earendil-works/pi-coding-agent@${PI_SUPPORTED_VERSION}`,
    });
  }
  const required = [
    ['supportsJsonMode', '--mode json'],
    ['supportsNoSession', '--no-session'],
    ['supportsNoSkills', '--no-skills'],
    ['supportsNoPromptTemplates', '--no-prompt-templates'],
    ['supportsNoContextFiles', '--no-context-files'],
    ['supportsNoApprove', '--no-approve'],
  ] as const;
  for (const [field, flag] of required) {
    if (features[field] !== false) continue;
    throw contractError({
      code: 'invalid-field',
      field: `options.cliFeatures.${field}`,
      exitCode: 2,
      message: `Pi ${PI_SUPPORTED_VERSION}+ support for ${flag} is required for Zeroshot execution.`,
    });
  }
  if (options.modelSpec?.model && features.supportsModel === false) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.cliFeatures.supportsModel',
      exitCode: 2,
      message: `Pi ${PI_SUPPORTED_VERSION}+ support for --model is required for explicit model selection.`,
    });
  }
  if (options.modelSpec?.reasoningEffort && features.supportsThinking === false) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.cliFeatures.supportsThinking',
      exitCode: 2,
      message: `Pi ${PI_SUPPORTED_VERSION}+ support for --thinking is required for reasoning effort.`,
    });
  }
}

function addRequiredArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (features.supportsJsonMode !== false) args.push('--mode', 'json');
  if (features.supportsNoSession !== false) args.push('--no-session');
  if (features.supportsNoSkills !== false) args.push('--no-skills');
  if (features.supportsNoPromptTemplates !== false) args.push('--no-prompt-templates');
  if (features.supportsNoContextFiles !== false) args.push('--no-context-files');
  if (features.supportsNoApprove !== false) args.push('--no-approve');
}

function addOptionalArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.modelSpec?.model && features.supportsModel !== false) {
    args.push('--model', options.modelSpec.model);
  }
  if (options.modelSpec?.reasoningEffort && features.supportsThinking !== false) {
    args.push('--thinking', options.modelSpec.reasoningEffort);
  }
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
      'Pi CLI does not support resume/continue session control with a task-owned identity boundary.',
  });
}

function collectWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  const warnings: WarningMetadata[] = [];

  if (options.jsonSchema) {
    warnings.push(
      warning(
        'pi',
        'pi-jsonschema',
        'Pi CLI does not support provider-native JSON schema; appending schema instructions to the prompt.'
      )
    );
  }
  return warnings;
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  failClosedUnsupportedSessionControl(options);
  assertRequiredControls(options);
  const finalContext = options.jsonSchema
    ? appendJsonSchemaPrompt(context, options.jsonSchema)
    : context;
  const args: string[] = [];

  addRequiredArgs(args, options);
  addOptionalArgs(args, options);
  // Pi has no `--` end-of-options sentinel and interprets leading `-`/`@` positional values as
  // flags or file arguments. A leading space keeps arbitrary Zeroshot context in prompt mode.
  args.push(` ${finalContext}`);

  return commandSpec({
    binary: 'pi',
    args,
    env: {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    warnings: collectWarnings(options),
  });
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
  if (typeof modelId !== 'string') {
    throw new Error(`Invalid model "${unknownToMessage(modelId)}" for provider "pi".`);
  }
  return modelId;
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    [
      /\brate(?:[_ -]?limit| limited)\b/i,
      /\bquota\b/i,
      /\bresource[_ -]?exhausted\b/i,
      /\btemporar(?:y|ily)\b/i,
      /\boverloaded\b/i,
      /\bservice unavailable\b/i,
    ],
    [
      /\b(cancelled|canceled|aborted|interrupted)\b/i,
      /\brun\s*\/login\b/i,
      /\bmissing api key\b/i,
      /\bno api key found\b/i,
      /\bno valid authentication\b/i,
      /\bmodel\b.*\bnot found\b/i,
      /\bunknown option\b/i,
      /\bfailed to load\b/i,
      /\bcannot find module\b/i,
      /\bno such file or directory\b/i,
    ]
  );
}

export const piAdapter: ProviderAdapter = {
  id: 'pi',
  displayName: 'Pi',
  binary: 'pi',
  adapterVersion: '2',
  credentialEnvKeys: PI_CREDENTIAL_ENV_KEYS,
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  parseEvent: parsePiEvent,
  finishParsing: finishPiParsing,
  createParserState: createPiParserState,
  resolveModelSpec,
  validateModelId,
  classifyError,
};
