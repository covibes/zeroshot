import { contractError } from '../contract-errors';
import { UnsupportedProviderCapabilityError } from '../errors';
import { appendJsonSchemaPrompt } from '../schema';
import { isRecord, unknownToMessage } from '../json';
import { OMP_REMEDIATION, OMP_SUPPORTED_VERSION } from '../omp/release';
import { parseNormalizedOmpRpcEventLine } from '../omp/rpc-events';
import type { OmpSessionLaunch } from '../omp/rpc-session';
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
import {
  OMP_CREDENTIAL_ENV_KEYS,
  OMP_PERMANENT_PATTERNS,
  OMP_RETRYABLE_PATTERNS,
} from './omp-policy';

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

const CREDENTIAL_ENV_KEYS = OMP_CREDENTIAL_ENV_KEYS;

const VERSION_TOKEN_PATTERN = /(?<![\w.])17\.2\.1(?![\w.])/;
const MODEL_ID_PATTERN =
  /^(?=.{1,128}$)(?:@?[A-Za-z0-9][A-Za-z0-9._:/-]*|[a-z0-9][a-z0-9._-]*\/~[A-Za-z0-9][A-Za-z0-9._:/-]*)$/u;

function detectCliFeatures(helpText?: string | null, versionText?: string | null): OmpCliFeatures {
  const help = helpText ?? '';
  const version = (versionText ?? '').trim();
  return {
    provider: 'omp',
    versionMatches: VERSION_TOKEN_PATTERN.test(version),
    supportsRpcMode: /(?<![A-Za-z0-9_-])rpc(?![A-Za-z0-9_-])/.test(help),
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

function resolveOmpSessionLaunch(options: BuildProviderCommandOptions): OmpSessionLaunch {
  return options.ompSession ?? { kind: 'none' };
}

function assertRequiredOmpFeatures(options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  const session = resolveOmpSessionLaunch(options);
  const required: ReadonlyArray<readonly [boolean | undefined, string]> = [
    [features.versionMatches, `exact OMP version ${OMP_SUPPORTED_VERSION}`],
    [features.supportsRpcMode, '"rpc" mode'],
    [features.supportsConfig, '--config'],
    [features.supportsModel, '--model'],
    [features.supportsApprovalMode, '--approval-mode'],
    [features.supportsNoTitle, '--no-title'],
    [features.supportsNoSession, '--no-session'],
    ...(session.kind === 'none'
      ? []
      : ([[features.supportsSessionDir, '--session-dir']] as const)),
    ...(session.kind === 'resume' ? ([[features.supportsResume, '--resume']] as const) : []),
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
  if (options.continueSession) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.continueSession',
      exitCode: 2,
      message: 'OMP RPC lane never supports --continue; continuation is always an explicit verified --resume partition.',
    });
  }
  const hasVerifiedResume = resolveOmpSessionLaunch(options).kind === 'resume';
  if (options.resumeSessionId !== undefined && !hasVerifiedResume) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.resumeSessionId',
      exitCode: 2,
      message:
        'OMP RPC lane requires a verified session partition (options.ompSession.kind === "resume") to resume; a bare session ID cannot be trusted.',
    });
  }
}

function sessionArgs(session: OmpSessionLaunch): readonly string[] {
  switch (session.kind) {
    case 'none':
      return ['--no-session'];
    case 'fresh':
      return ['--session-dir', session.partition.path];
    case 'resume':
      return ['--session-dir', session.partition.path, '--resume', session.file.path];
  }
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
  const session = resolveOmpSessionLaunch(options);

  const args: string[] = ['--mode', 'rpc', ...sessionArgs(session), '--model', modelSelector];
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
