import { getProviderAdapter } from './adapters';
import { envRedactions, mergeEnvForRedaction } from './contract-env';
import { ContractRequestError, contractError } from './contract-errors';
import {
  errorEnvelope,
  type ContractErrorObject,
  type ContractEnvelope,
} from './contract-envelope';
import { UnsupportedProviderCapabilityError } from './errors';
import { getString, isRecord, parseJson, unknownToMessage } from './json';
import { mergeRedactions, redactString } from './redaction';
import type { ProviderAdapter } from './types';
import type { RequestData } from './contract-support';

export function requestEnvelopeData(input: string): RequestData {
  try {
    const parsed = parseJson(input);
    if (isRecord(parsed)) {
      return {
        raw: parsed,
        command: getString(parsed, 'command'),
        provider: getString(parsed, 'provider'),
        env: fallbackRedactionEnv(parsed),
      };
    }
  } catch {
    return { raw: {}, command: null, provider: null, env: {} };
  }
  return { raw: {}, command: null, provider: null, env: {} };
}

function fallbackStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

function fallbackRedactionEnv(value: Record<string, unknown>): Readonly<Record<string, string>> {
  const options = isRecord(value.options) ? value.options : {};
  return mergeEnvForRedaction(
    { source: 'request', env: fallbackStringRecord(value.env) },
    { source: 'options.authEnv', env: fallbackStringRecord(options.authEnv) }
  );
}

function redactFallbackField(input: {
  readonly value: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly untrusted: boolean;
}): {
  readonly value: string | null;
  readonly redactions: ReturnType<typeof redactString>['redactions'];
} {
  if (input.value === null || !input.untrusted) return { value: input.value, redactions: [] };
  const result = redactString(input.value, input.env);
  if (typeof result.value !== 'string') {
    throw new Error('Redacted provider contract field lost its string shape.');
  }
  return { value: result.value, redactions: result.redactions };
}

function errorObject(requestError: ContractRequestError): ContractErrorObject {
  if (requestError.field === undefined) {
    return {
      code: requestError.code,
      message: requestError.message,
    };
  }
  return {
    code: requestError.code,
    message: requestError.message,
    field: requestError.field,
  };
}

export function requestErrorFromUnknown(error: unknown): ContractRequestError {
  if (error instanceof ContractRequestError) return error;
  if (error instanceof UnsupportedProviderCapabilityError) {
    return contractError({
      code: error.code,
      message: error.message,
      exitCode: 4,
      field: 'options.webSearch',
    });
  }
  return contractError({
    code: 'internal-error',
    message: unknownToMessage(error),
    exitCode: 5,
  });
}

export function fallbackErrorEnvelope(
  fallback: RequestData,
  requestError: ContractRequestError
): ContractEnvelope {
  const adapter = fallback.provider === null ? null : providerAdapterOrNull(fallback.provider);
  const command = redactFallbackField({
    value: fallback.command,
    env: fallback.env,
    untrusted: requestError.field === 'command',
  });
  const provider = redactFallbackField({
    value: fallback.provider,
    env: fallback.env,
    untrusted: requestError.field === 'provider',
  });
  return errorEnvelope({
    command: command.value,
    provider: provider.value,
    adapterVersion: adapter?.adapterVersion ?? null,
    redactions: mergeRedactions(
      envRedactions(fallback.env),
      command.redactions,
      provider.redactions
    ),
    error: errorObject(requestError),
  });
}

function providerAdapterOrNull(provider: string): ProviderAdapter | null {
  try {
    return getProviderAdapter(provider);
  } catch {
    return null;
  }
}
