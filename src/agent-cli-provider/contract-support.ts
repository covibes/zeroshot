import * as fs from 'node:fs';

import { getProviderAdapter } from './adapters';
import { getString, isRecord, parseJson } from './json';
import { mergeRedactions } from './redaction';
import { requestOptions } from './contract-options';
import {
  prepareSingleAgentProviderCommand,
  type PreparedSingleAgentProviderCommand,
} from './single-agent-runtime';
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
  const rawOptionExecutionContext = isRecord(request.raw.options)
    ? request.raw.options.executionContext
    : undefined;
  if (
    rawOptionExecutionContext !== undefined &&
    typeof rawOptionExecutionContext !== 'string'
  ) {
    throw contractError({
      code: 'invalid-field',
      message:
        'options.executionContext must be "host", "detached", "docker", or "benchmark".',
      exitCode: 2,
      field: 'options.executionContext',
    });
  }
  const topLevelExecutionContext = optionalString(request.raw, 'executionContext');
  const rawExecutionContext = rawOptionExecutionContext ?? topLevelExecutionContext;
  let executionContext: BuildProviderCommandOptions['executionContext'];
  if (
    rawExecutionContext === undefined ||
    rawExecutionContext === 'host' ||
    rawExecutionContext === 'detached' ||
    rawExecutionContext === 'docker' ||
    rawExecutionContext === 'benchmark'
  ) {
    executionContext = rawExecutionContext;
  } else {
    throw contractError({
      code: 'invalid-field',
      message: `${
        rawOptionExecutionContext === undefined ? 'executionContext' : 'options.executionContext'
      } must be "host", "detached", "docker", or "benchmark".`,
      exitCode: 2,
      field:
        rawOptionExecutionContext === undefined
          ? 'executionContext'
          : 'options.executionContext',
    });
  }
  return {
    ...options,
    ...(cwd === undefined || options.cwd !== undefined ? {} : { cwd }),
    ...(executionContext === undefined ? {} : { executionContext }),
  };
}

export interface PreparedCommandSpec extends PreparedSingleAgentProviderCommand {
  readonly context: string;
}

export function buildCommandSpec(
  request: RequestData,
  runtimeSettings?: Record<string, unknown>
): PreparedCommandSpec {
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
  if (prepared.invoke.parser === 'omp-sdk-ndjson' && Object.keys(request.env).length > 0) {
    const privateRoot = prepared.privateArtifacts?.root;
    if (privateRoot !== undefined) {
      try {
        fs.rmSync(privateRoot, { recursive: true, force: true });
        if (fs.existsSync(privateRoot)) throw new Error('private root still exists');
      } catch {
        throw contractError({
          code: 'invalid-request',
          message: 'OMP SDK private request cleanup failed before spawn.',
          exitCode: 1,
          field: 'env',
        });
      }
    }
    throw contractError({
      code: 'forbidden-field',
      message:
        'env is not accepted for OMP SDK requests; the final spawn owner resolves only credential names declared by providerSettings.omp.auth.',
      exitCode: 2,
      field: 'env',
    });
  }
  return {
    ...prepared,
    context,
    commandSpec:
      prepared.invoke.parser === 'omp-sdk-ndjson'
        ? prepared.commandSpec
        : mergeCommandSpec(prepared.commandSpec, request.env),
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
