import { stringifyJson } from '../json';
import { contractError } from '../contract-errors';
import {
  type BuildProviderCommandOptions,
  type ClaudeCliFeatures,
  type CommandSpec,
  type ErrorClassification,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type ProviderAdapter,
  type ResolvedModelSpec,
  type WarningMetadata,
} from '../types';
import { resolveClaudeCommand } from '../claude-command';
import {
  classifyBaseProviderError,
  commandSpec,
  createParserState,
  envRedactions,
  optionFeatures,
  resolveModelSpecWithConfig,
  validateModelIdFromCatalog,
  warning,
} from './common';
import { parseClaudeEvent } from './claude-parser';

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  haiku: { rank: 1 },
  'claude-haiku-4-5': { rank: 1 },
  'claude-haiku-4-5-20251001': { rank: 1 },
  sonnet: { rank: 2 },
  'claude-sonnet-4-5': { rank: 2 },
  'claude-sonnet-4-5-20250929': { rank: 2 },
  'claude-sonnet-4-6': { rank: 2 },
  'claude-sonnet-5': { rank: 2 },
  opus: { rank: 3 },
  'claude-opus-4-5': { rank: 3 },
  'claude-opus-4-5-20251101': { rank: 3 },
  'claude-opus-4-6': { rank: 3 },
  'claude-opus-4-7': { rank: 3 },
  'claude-opus-4-8': { rank: 3 },
  'claude-opus-5': { rank: 3 },
  fable: { rank: 3 },
  'claude-fable-5': { rank: 3 },
  'claude-mythos-5': { rank: 3 },
  'claude-mythos-preview': { rank: 3 },
};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: 'haiku' },
  level2: { rank: 2, model: 'sonnet' },
  level3: { rank: 3, model: 'opus' },
};

function detectCliFeatures(helpText?: string | null): ClaudeCliFeatures {
  const help = helpText ?? '';
  const unknown = !help;
  return {
    provider: 'claude',
    supportsOutputFormat: unknown ? true : /--output-format/.test(help),
    supportsStreamJson: unknown ? true : /stream-json/.test(help),
    supportsJsonSchema: unknown ? true : /--json-schema/.test(help),
    supportsAutoApprove: unknown ? true : /--dangerously-skip-permissions/.test(help),
    supportsIncludePartials: unknown ? true : /--include-partial-messages/.test(help),
    supportsVerbose: unknown ? true : /--verbose/.test(help),
    supportsModel: unknown ? true : /--model/.test(help),
    supportsEffort: unknown ? true : /--effort/.test(help),
    // Settings carry mandatory safety hooks, so an unprobed or old CLI must
    // fail closed before a provider process is spawned.
    supportsSettings: !unknown && /--settings/.test(help),
    supportsMcpConfig: !unknown && /--mcp-config/.test(help),
    unknown,
  };
}

function addOutputArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.outputFormat && features.supportsOutputFormat !== false) {
    args.push('--output-format', options.outputFormat);
  }
  if (options.outputFormat === 'stream-json') {
    if (features.supportsVerbose !== false) args.push('--verbose');
    if (features.supportsIncludePartials !== false) args.push('--include-partial-messages');
  }
}

function addSchemaArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (
    options.jsonSchema &&
    options.outputFormat === 'json' &&
    features.supportsJsonSchema !== false
  ) {
    args.push(
      '--json-schema',
      typeof options.jsonSchema === 'string'
        ? options.jsonSchema
        : stringifyJson(options.jsonSchema)
    );
  }
}

function addModelArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.modelSpec?.model && features.supportsModel !== false) {
    args.push('--model', options.modelSpec.model);
  }
  if (options.modelSpec?.reasoningEffort && features.supportsEffort !== false) {
    args.push('--effort', options.modelSpec.reasoningEffort);
  }
}

function addAutoApproveArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.autoApprove && features.supportsAutoApprove !== false) {
    args.push('--dangerously-skip-permissions');
  }
}

function addSessionArgs(args: string[], options: BuildProviderCommandOptions): void {
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
    return;
  }
  if (options.continueSession) {
    args.push('--continue');
  }
}

function addSettingsArgs(args: string[], options: BuildProviderCommandOptions): void {
  const settingsPath = options.claudeSettingsFile?.trim();
  if (settingsPath) {
    args.push('--settings', settingsPath);
  }
}

function addMcpConfigArgs(args: string[], options: BuildProviderCommandOptions): void {
  if (!options.mcpConfig?.length) return;
  args.push('--mcp-config', ...options.mcpConfig);
}

function failClosedUnsupportedRunConfig(options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.claudeSettingsFile?.trim() && features.supportsSettings === false) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.cliFeatures.supportsSettings',
      exitCode: 2,
      message:
        'Claude CLI does not advertise --settings support required for Zeroshot safety hooks. Upgrade Claude Code before running this task.',
    });
  }
  if (options.mcpConfig?.length && features.supportsMcpConfig === false) {
    throw contractError({
      code: 'invalid-field',
      field: 'options.cliFeatures.supportsMcpConfig',
      exitCode: 2,
      message:
        'Claude CLI does not advertise --mcp-config support required to preserve repository MCP tools. Upgrade Claude Code before running this task.',
    });
  }
}

function collectWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  const features = optionFeatures(options);
  const warnings: WarningMetadata[] = [];
  if (options.jsonSchema && options.outputFormat !== 'json' && !options.strictSchema) {
    warnings.push(
      warning(
        'claude',
        'claude-jsonschema-stream',
        'jsonSchema requested with stream output; schema enforcement will be post-validated.'
      )
    );
  }
  if (
    options.jsonSchema &&
    options.outputFormat === 'json' &&
    features.supportsJsonSchema === false
  ) {
    warnings.push(
      warning(
        'claude',
        'claude-jsonschema-flag',
        'Claude CLI does not support --json-schema; skipping schema flag.'
      )
    );
  }
  if (options.autoApprove && features.supportsAutoApprove === false) {
    warnings.push(
      warning(
        'claude',
        'claude-auto-approve',
        'Claude CLI does not support --dangerously-skip-permissions; continuing without auto-approve.'
      )
    );
  }
  if (options.modelSpec?.reasoningEffort && features.supportsEffort === false) {
    warnings.push(
      warning(
        'claude',
        'claude-reasoning',
        'Claude CLI does not support --effort; skipping reasoningEffort.'
      )
    );
  }
  return warnings;
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  failClosedUnsupportedRunConfig(options);
  const { command, args: commandPrefix } = resolveClaudeCommand();
  const args: string[] = [...commandPrefix, '--print'];
  const authEnv = options.authEnv ?? {};

  // --mcp-config is variadic. A following option terminates its values before
  // the positional prompt.
  addMcpConfigArgs(args, options);
  args.push('--input-format', 'text');
  addOutputArgs(args, options);
  addSchemaArgs(args, options);
  addModelArgs(args, options);
  addAutoApproveArgs(args, options);
  addSessionArgs(args, options);
  addSettingsArgs(args, options);

  args.push(context);

  return commandSpec({
    binary: command,
    args,
    env: authEnv,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    warnings: collectWarnings(options),
    redactions: envRedactions(authEnv),
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
  return validateModelIdFromCatalog('claude', MODEL_CATALOG, modelId);
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    [/no messages returned/i, /\boverloaded\b/i, /\brate[_ -]?limit\b/i],
    [/invalid_request_error/i, /model_not_available/i]
  );
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude',
  binary: 'claude',
  adapterVersion: '1',
  credentialEnvKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  parseEvent: parseClaudeEvent,
  createParserState: () => createParserState('claude'),
  resolveModelSpec,
  validateModelId,
  classifyError,
};
