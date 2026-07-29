import { isRecord } from './json';
import { invalidField, contractError } from './contract-errors';
import { stringRecord } from './contract-env';
import { normalizeGatewayBuildOptions } from './gateway-tools';
import type {
  BuildProviderCommandOptions,
  CliFeatureOverrides,
  ModelLevel,
  ModelSpec,
  OutputFormat,
  ReasoningEffort,
} from './types';

const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'stream-json'];
const MODEL_LEVELS: readonly ModelLevel[] = ['level1', 'level2', 'level3'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLI_FEATURE_FIELDS = [
  'supportsOutputFormat',
  'supportsStreamJson',
  'supportsJsonSchema',
  'supportsAutoApprove',
  'supportsIncludePartials',
  'supportsVerbose',
  'supportsModel',
  'supportsEffort',
  'supportsSettings',
  'supportsJson',
  'supportsOutputSchema',
  'supportsDir',
  'supportsCwd',
  'supportsConfigOverride',
  'supportsSkipGitRepoCheck',
  'supportsVariant',
  'supportsJsonMode',
  'supportsNoSession',
  'supportsNoExtensions',
  'supportsNoSkills',
  'supportsNoPromptTemplates',
  'supportsNoContextFiles',
  'supportsNoApprove',
  'supportsJsonOutput',
  'supportsAllowAll',
  'supportsNoAskUser',
  'supportsAddDir',
  'supportsMcpConfig',
  'supportsResume',
  'supportsBundledRunner',
  'supportsAcpStdio',
  'supportsPromptImages',
  'supportsLoadSession',
  'supportsSessionCancel',
  'supportsSessionSetModel',
  'supportsSessionSetMode',
  'supportsRemoteTransport',
  'supportsCustomTransport',
  'supportsPermissionRequests',
  'supportsFsTools',
  'supportsTerminalTools',
  'unknown',
] as const;

type CliFeatureField = (typeof CLI_FEATURE_FIELDS)[number];
const FALSE_ONLY_CLI_FEATURE_FIELDS = new Set<CliFeatureField>([
  'supportsRemoteTransport',
  'supportsCustomTransport',
  'supportsPermissionRequests',
  'supportsFsTools',
  'supportsTerminalTools',
]);

export function requestOptions(value: unknown): BuildProviderCommandOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw contractError({
      code: 'invalid-field',
      message: 'options must be an object.',
      exitCode: 2,
      field: 'options',
    });
  }
  rejectProviderCommandOverrides(value);
  return normalizeBuildOptions(value);
}

function rejectProviderCommandOverrides(value: Record<string, unknown>): void {
  for (const field of ['command', 'commandArgs']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    throw contractError({
      code: 'forbidden-field',
      message: `options.${field} is not accepted by provider executable requests; provider adapters own executable binaries and arguments.`,
      exitCode: 2,
      field: `options.${field}`,
    });
  }
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  invalidField(field, `${field} must be a string.`);
}

function optionalNullableStringValue(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  invalidField(field, `${field} must be a string or null.`);
}

function optionalBooleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  invalidField(field, `${field} must be a boolean.`);
}

function optionalMcpConfig(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    invalidField('options.mcpConfig', 'options.mcpConfig must be an array of strings.');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      invalidField(`options.mcpConfig[${index}]`, `options.mcpConfig[${index}] must be a string.`);
    }
    if (item.trim().length === 0) {
      invalidField(
        `options.mcpConfig[${index}]`,
        `options.mcpConfig[${index}] must be a non-empty string.`
      );
    }
    return item;
  });
}

function optionalEnumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    invalidField(field, `${field} must be a string.`);
  }
  for (const item of allowed) {
    if (value === item) return item;
  }
  invalidField(field, `${field} must be one of: ${allowed.join(', ')}.`);
}

function optionalModelSpec(value: unknown): ModelSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalidField('options.modelSpec', 'options.modelSpec must be an object.');
  }

  const level = optionalEnumValue(value.level, 'options.modelSpec.level', MODEL_LEVELS);
  const model = optionalNullableStringValue(value.model, 'options.modelSpec.model');
  const reasoningEffort = optionalEnumValue(
    value.reasoningEffort,
    'options.modelSpec.reasoningEffort',
    REASONING_EFFORTS
  );

  return {
    ...(level === undefined ? {} : { level }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function optionalCliFeatures(value: unknown): CliFeatureOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalidField('options.cliFeatures', 'options.cliFeatures must be an object.');
  }

  const result: Record<string, boolean> = {};
  for (const field of CLI_FEATURE_FIELDS) {
    const item = optionalBooleanValue(value[field], `options.cliFeatures.${field}`);
    if (item === undefined) continue;
    if (item && FALSE_ONLY_CLI_FEATURE_FIELDS.has(field)) {
      invalidField(
        `options.cliFeatures.${field}`,
        `options.cliFeatures.${field} must be false when provided.`
      );
    }
    result[field] = item;
  }
  return result as CliFeatureOverrides;
}

function normalizeBuildOptions(value: Record<string, unknown>): BuildProviderCommandOptions {
  const result: Record<string, unknown> = {};
  addDefined(result, 'modelSpec', optionalModelSpec(value.modelSpec));
  addDefined(
    result,
    'outputFormat',
    optionalEnumValue(value.outputFormat, 'options.outputFormat', OUTPUT_FORMATS)
  );
  addPresent(result, value, 'jsonSchema');
  addDefined(result, 'cwd', optionalStringValue(value.cwd, 'options.cwd'));
  addDefined(result, 'autoApprove', optionalBooleanValue(value.autoApprove, 'options.autoApprove'));
  addDefined(
    result,
    'resumeSessionId',
    optionalStringValue(value.resumeSessionId, 'options.resumeSessionId')
  );
  addDefined(
    result,
    'continueSession',
    optionalBooleanValue(value.continueSession, 'options.continueSession')
  );
  addDefined(
    result,
    'claudeSettingsFile',
    optionalStringValue(value.claudeSettingsFile, 'options.claudeSettingsFile')
  );
  addDefined(result, 'cliFeatures', optionalCliFeatures(value.cliFeatures));
  addDefined(result, 'mcpConfig', optionalMcpConfig(value.mcpConfig));
  addDefined(
    result,
    'strictSchema',
    optionalBooleanValue(value.strictSchema, 'options.strictSchema')
  );
  addDefined(
    result,
    'gateway',
    normalizeGatewayBuildOptions(
      value.gateway,
      'options.gateway',
      optionalStringValue(value.cwd, 'options.cwd') ?? process.cwd()
    )
  );
  if (Object.prototype.hasOwnProperty.call(value, 'authEnv')) {
    result.authEnv = stringRecord(value.authEnv, 'options.authEnv');
  }
  return result as BuildProviderCommandOptions;
}

function addDefined(result: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) result[key] = value;
}

function addPresent(
  result: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string
): void {
  if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = input[key];
}
