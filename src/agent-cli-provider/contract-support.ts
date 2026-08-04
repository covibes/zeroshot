import { getProviderAdapter } from './adapters';
import { getString, isRecord, parseJson } from './json';
import { mergeRedactions } from './redaction';
import { requestOptions } from './contract-options';
import { prepareSingleAgentProviderCommand } from './single-agent-runtime';
import type { BuildProviderCommandOptions, CommandSpec, ProviderAdapter } from './types';
export {
  contractError,
  ContractRequestError,
  optionalNumber,
  optionalString,
  requiredString,
} from './contract-errors';
export {
  collectCommandSpecEnv,
  commandRedactions,
  envRedactions,
  mergeEnvForRedaction,
  providerCredentialEnv,
  stringRecord,
} from './contract-env';
import { contractError, optionalString, requiredString } from './contract-errors';
import { envRedactions, stringRecord } from './contract-env';

export interface RequestData {
  readonly raw: Record<string, unknown>;
  readonly command: string | null;
  readonly provider: string | null;
  readonly env: Readonly<Record<string, string>>;
}

export function adapterForProvider(provider: string | null): ProviderAdapter {
  if (provider === null || provider.length === 0) {
    throw contractError({
      code: 'missing-field',
      message: 'provider is required.',
      exitCode: 2,
      field: 'provider',
    });
  }
  try {
    return getProviderAdapter(provider);
  } catch (error) {
    throw contractError({
      code: 'unknown-provider',
      message: error instanceof Error ? error.message : `Unknown provider: ${provider}.`,
      exitCode: 4,
      field: 'provider',
    });
  }
}

function mergeCommandSpec(
  commandSpec: CommandSpec,
  env: Readonly<Record<string, string>>
): CommandSpec {
  const overriddenKey = findReservedCommandEnvKey(commandSpec.env, env);
  if (overriddenKey !== null) {
    throw contractError({
      code: 'forbidden-field',
      message: `env.${overriddenKey.requestKey} is not accepted by provider executable requests; provider adapters own ${overriddenKey.commandKey} and other runner control/auth environment variables.`,
      exitCode: 2,
      field: `env.${overriddenKey.requestKey}`,
    });
  }

  const mergedEnv = { ...env, ...commandSpec.env };
  return {
    ...commandSpec,
    env: mergedEnv,
    redactions: mergeRedactions(commandSpec.redactions, envRedactions(mergedEnv)),
  };
}

function findReservedCommandEnvKey(
  commandEnv: Readonly<Record<string, string>>,
  requestedEnv: Readonly<Record<string, string>>
): { readonly requestKey: string; readonly commandKey: string } | null {
  const commandEnvKeys = new Map<string, string>();
  for (const key of Object.keys(commandEnv)) {
    commandEnvKeys.set(key.toLowerCase(), key);
  }
  for (const key of Object.keys(requestedEnv)) {
    const commandKey = commandEnvKeys.get(key.toLowerCase());
    if (commandKey !== undefined) return { requestKey: key, commandKey };
  }
  return null;
}

function buildOptions(request: RequestData): BuildProviderCommandOptions {
  const options = requestOptions(request.raw.options);
  const cwd = optionalString(request.raw, 'cwd');
  if (cwd === undefined || options.cwd !== undefined) return options;
  return { ...options, cwd };
}

export function buildCommandSpec(
  request: RequestData,
  runtimeSettings?: Record<string, unknown>
): {
  readonly adapter: ProviderAdapter;
  readonly commandSpec: CommandSpec;
  readonly options: BuildProviderCommandOptions;
  readonly context: string;
} {
  const adapter = adapterForProvider(request.provider);
  const context = requiredString(request.raw, 'context');
  const options = buildOptions(request);
  const prepared = prepareSingleAgentProviderCommand(
    {
      provider: adapter.id,
      context,
      options,
    },
    runtimeSettings
  );
  return {
    adapter: prepared.adapter,
    context,
    options: prepared.options,
    commandSpec: mergeCommandSpec(prepared.commandSpec, request.env),
  };
}

export function schemaMode(options: BuildProviderCommandOptions): string {
  if (!options.jsonSchema) return 'none';
  return options.strictSchema === false ? 'prompt' : 'strict';
}

export function validateRequest(input: string, schemaVersion: 1): RequestData {
  const parsed = parseRequestObject(input);
  assertSchemaVersion(parsed, schemaVersion);
  const command = requiredCommand(parsed);
  return {
    raw: parsed,
    command,
    provider: getString(parsed, 'provider'),
    env: requestEnv(parsed),
  };
}

const KNOWN_COMMANDS: readonly string[] = [
  'probe',
  'build-command',
  'parse-output',
  'classify-error',
  'invoke',
];

function parseRequestObject(input: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJson(input);
  } catch {
    throw contractError({
      code: 'malformed-json',
      message: 'Request body must be valid JSON.',
      exitCode: 2,
    });
  }
  if (isRecord(parsed)) return parsed;
  throw contractError({
    code: 'invalid-request',
    message: 'Request body must be a JSON object.',
    exitCode: 2,
  });
}

function assertSchemaVersion(parsed: Record<string, unknown>, schemaVersion: 1): void {
  if (parsed.schemaVersion === schemaVersion) return;
  throw contractError({
    code: 'unsupported-schema-version',
    message: 'schemaVersion must be 1.',
    exitCode: 2,
    field: 'schemaVersion',
  });
}

function requiredCommand(parsed: Record<string, unknown>): string {
  const command = getString(parsed, 'command');
  if (command === null) {
    throw contractError({
      code: 'missing-field',
      message: 'command is required.',
      exitCode: 2,
      field: 'command',
    });
  }
  if (KNOWN_COMMANDS.includes(command)) return command;
  throw contractError({
    code: 'unknown-command',
    message: `Unknown command: ${command}.`,
    exitCode: 3,
    field: 'command',
  });
}

function requestEnv(parsed: Record<string, unknown>): Readonly<Record<string, string>> {
  return stringRecord(parsed.env, 'env');
}
