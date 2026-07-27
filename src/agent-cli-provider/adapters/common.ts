import {
  basePermanentErrorPatterns,
  baseRetryableErrorPatterns,
  classifyErrorWithPatterns,
} from '../errors';
import {
  InvalidProviderModelError,
  type BuildProviderCommandOptions,
  type CliFeatureOverrides,
  type CleanupMetadata,
  type CommandSpec,
  type ErrorClassification,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type ProviderId,
  type ProviderParserState,
  type RedactionMetadata,
  type ResolvedModelSpec,
  type WarningMetadata,
} from '../types';

export function createParserState(provider: ProviderId): ProviderParserState {
  return {
    provider,
    lastToolId: undefined,
  };
}

export function commandSpec(input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly cleanup?: readonly string[];
  readonly cleanupMetadata?: readonly CleanupMetadata[];
  readonly warnings?: readonly WarningMetadata[];
  readonly redactions?: readonly RedactionMetadata[];
}): CommandSpec {
  const spec = {
    binary: input.binary,
    args: input.args,
    env: input.env ?? {},
    cleanupMetadata: input.cleanupMetadata ?? [],
    warnings: input.warnings ?? [],
    redactions: input.redactions ?? [],
  };
  const specWithCwd = input.cwd === undefined ? spec : { ...spec, cwd: input.cwd };
  if (input.cleanup === undefined) return specWithCwd;
  return { ...specWithCwd, cleanup: input.cleanup };
}

export function warning(provider: ProviderId, code: string, message: string): WarningMetadata {
  return { provider, code, message };
}

export function unsupportedSessionControlWarnings(
  provider: ProviderId,
  options: BuildProviderCommandOptions
): WarningMetadata[] {
  if (!options.resumeSessionId && !options.continueSession) return [];
  return [
    warning(
      provider,
      'unsupported-session-control',
      `Provider ${provider} does not support resume/continue session control; ignoring.`
    ),
  ];
}

export function envRedactions(env: Readonly<Record<string, string>>): readonly RedactionMetadata[] {
  return Object.keys(env).map((key) => ({ kind: 'env', key }));
}

interface ModelResolutionConfig {
  readonly mapping: Readonly<Record<ModelLevel, LevelModelSpec>>;
  readonly defaultLevel: ModelLevel;
  readonly level: ModelLevel;
  readonly overrides: LevelOverrides | undefined;
  readonly validateModelId: (modelId: string | null | undefined) => string | null | undefined;
}

export function resolveModelSpecWithConfig(config: ModelResolutionConfig): ResolvedModelSpec {
  const base = config.mapping[config.level] ?? config.mapping[config.defaultLevel];
  const override = config.overrides?.[config.level];
  const selectedModel = override?.model || base.model;
  const validatedModel = config.validateModelId(selectedModel);
  return {
    level: config.level,
    model: validatedModel ?? null,
    reasoningEffort: override?.reasoningEffort || base.reasoningEffort,
  };
}

export function validateModelIdFromCatalog(
  provider: ProviderId,
  catalog: Readonly<Record<string, ModelCatalogEntry>>,
  modelId: string | null | undefined
): string | null | undefined {
  if (!modelId) return modelId;
  if (catalog[modelId] !== undefined) return modelId;
  const validModels = Object.keys(catalog).join(', ');
  throw new InvalidProviderModelError(
    `Invalid model "${modelId}" for provider "${provider}". Valid models: ${validModels}.`
  );
}

export function classifyBaseProviderError(
  error: unknown,
  retryablePatterns: readonly RegExp[],
  permanentPatterns: readonly RegExp[]
): ErrorClassification {
  return classifyErrorWithPatterns(
    error,
    [...baseRetryableErrorPatterns(), ...retryablePatterns],
    [...basePermanentErrorPatterns(), ...permanentPatterns]
  );
}

export function optionFeatures(
  options: BuildProviderCommandOptions | undefined
): CliFeatureOverrides {
  return options?.cliFeatures ?? {};
}
