import { getString, isRecord, tryParseJson } from '../json';
import { appendJsonSchemaPrompt, writeStrictOutputSchemaFile } from '../schema';
import {
  type BuildProviderCommandOptions,
  type CodexCliFeatures,
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
import {
  classifyBaseProviderError,
  commandSpec,
  createParserState,
  optionFeatures,
  resolveModelSpecWithConfig,
  validateModelIdFromCatalog,
  warning,
} from './common';
import { parseCodexEvent } from './codex-parser';

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  'gpt-5.4': { rank: 2 },
  'gpt-5.5': { rank: 3 },
  'gpt-5.6': { rank: 3 },
  'gpt-5.6-sol': { rank: 3 },
  'openai.gpt-5.6-sol': { rank: 3 },
  'gpt-5.6-terra': { rank: 2 },
  'openai.gpt-5.6-terra': { rank: 2 },
  'gpt-5.6-luna': { rank: 1 },
  'openai.gpt-5.6-luna': { rank: 1 },
};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: 'gpt-5.4', reasoningEffort: 'medium' },
  level2: { rank: 2, model: 'gpt-5.4', reasoningEffort: 'high' },
  level3: { rank: 3, model: 'gpt-5.4', reasoningEffort: 'xhigh' },
};

function supports(help: string, pattern: RegExp): boolean {
  return help ? pattern.test(help) : true;
}

function detectCliFeatures(helpText?: string | null): CodexCliFeatures {
  const help = helpText ?? '';
  const unknown = !help;
  return {
    provider: 'codex',
    supportsJson: supports(help, /--json\b/),
    supportsOutputSchema: supports(help, /--output-schema\b/),
    supportsAutoApprove: supports(help, /--dangerously-bypass-approvals-and-sandbox\b/),
    supportsCwd: supports(help, /\s-C\b/) || supports(help, /--cwd\b/),
    supportsConfigOverride: supports(help, /--config\b/),
    supportsModel: supports(help, /\s-m\b/) || supports(help, /--model\b/),
    supportsSkipGitRepoCheck: supports(help, /--skip-git-repo-check\b/),
    supportsResume: supports(help, /\bresume\b/),
    unknown,
  };
}

function extractSessionId(line: string): string | null {
  const event = tryParseJson(line.trim());
  if (!isRecord(event) || getString(event, 'type') !== 'thread.started') return null;
  const sessionId = getString(event, 'thread_id');
  return sessionId?.trim() || null;
}

function addOutputArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (
    (options.outputFormat === 'stream-json' || options.outputFormat === 'json') &&
    features.supportsJson
  ) {
    args.push('--json');
  }
}

function addModelArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.modelSpec?.model) {
    args.push('-m', options.modelSpec.model);
  }
  if (options.modelSpec?.reasoningEffort && features.supportsConfigOverride) {
    args.push('--config', `model_reasoning_effort="${options.modelSpec.reasoningEffort}"`);
  }
}

function addCwdArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.cwd && features.supportsCwd) {
    args.push('-C', options.cwd);
  }
}

function addAutoApproveArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (options.autoApprove && features.supportsAutoApprove) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
}

function addSkipGitArgs(args: string[], options: BuildProviderCommandOptions): void {
  const features = optionFeatures(options);
  if (features.supportsSkipGitRepoCheck !== false) {
    args.push('--skip-git-repo-check');
  }
}

function applySchemaArgs(
  args: string[],
  cleanup: string[],
  context: string,
  options: BuildProviderCommandOptions
): string {
  const features = optionFeatures(options);
  if (options.jsonSchema && features.supportsOutputSchema) {
    const schemaFile = writeStrictOutputSchemaFile(options.jsonSchema);
    cleanup.push(schemaFile);
    args.push('--output-schema', schemaFile);
    return context;
  }
  return options.jsonSchema ? appendJsonSchemaPrompt(context, options.jsonSchema) : context;
}

function collectWarnings(options: BuildProviderCommandOptions): WarningMetadata[] {
  const features = optionFeatures(options);
  const warnings: WarningMetadata[] = [];
  if (options.continueSession) {
    warnings.push(
      warning(
        'codex',
        'unsupported-session-control',
        'Codex requires an explicit session ID; ignoring continueSession.'
      )
    );
  }
  if (options.resumeSessionId && features.supportsResume === false) {
    warnings.push(
      warning(
        'codex',
        'codex-session-resume-unsupported',
        'Codex CLI does not support exec resume; starting a fresh session.'
      )
    );
  }
  if (options.autoApprove && features.supportsAutoApprove === false) {
    warnings.push(
      warning(
        'codex',
        'codex-auto-approve',
        'Codex CLI does not support auto-approve; continuing without bypass flag.'
      )
    );
  }
  if (options.jsonSchema && features.supportsOutputSchema === false) {
    warnings.push(
      warning(
        'codex',
        'codex-jsonschema',
        'Codex CLI does not support --output-schema; skipping schema flag.'
      )
    );
  }
  if (options.modelSpec?.reasoningEffort && features.supportsConfigOverride === false) {
    warnings.push(
      warning(
        'codex',
        'codex-reasoning',
        'Codex CLI does not support --config overrides; skipping reasoningEffort.'
      )
    );
  }
  return warnings;
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  if (options.resumeSessionId && optionFeatures(options).supportsResume === false) {
    throw new Error(
      'Codex CLI cannot safely run continuation context because this installation lacks exec resume.'
    );
  }
  const args: string[] = ['exec'];
  const cleanup: string[] = [];
  const resumeSessionId =
    options.resumeSessionId && optionFeatures(options).supportsResume !== false
      ? options.resumeSessionId
      : null;
  if (resumeSessionId) {
    args.push('resume');
  }

  addOutputArgs(args, options);
  addModelArgs(args, options);
  if (!resumeSessionId) {
    addCwdArgs(args, options);
  }
  addAutoApproveArgs(args, options);
  addSkipGitArgs(args, options);
  const finalContext = applySchemaArgs(args, cleanup, context, options);

  if (resumeSessionId) {
    args.push(resumeSessionId);
  }
  args.push(finalContext);

  return commandSpec({
    binary: 'codex',
    args,
    env: {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    cleanup,
    cleanupMetadata: cleanup.map((schemaFile) => ({
      kind: 'temp-file',
      provider: 'codex',
      path: schemaFile,
      reason: 'output-schema',
    })),
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
  return validateModelIdFromCatalog('codex', MODEL_CATALOG, modelId);
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    [/rate_limit_exceeded/i, /\bserver_error\b/i, /\bservice_unavailable\b/i],
    [/\binsufficient_quota\b/i, /\bmodel_not_found\b/i, /\bcontext_length_exceeded\b/i]
  );
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  binary: 'codex',
  adapterVersion: '1',
  credentialEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  extractSessionId,
  parseEvent: parseCodexEvent,
  createParserState: () => createParserState('codex'),
  resolveModelSpec,
  validateModelId,
  classifyError,
};
