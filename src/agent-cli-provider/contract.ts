import { dispatchRequest } from './contract-actions';
import {
  fallbackErrorEnvelope,
  requestEnvelopeData,
  requestErrorFromUnknown,
} from './contract-fallback';
import { finalizeEnvelope, providerExecutableSchemaVersion } from './contract-envelope';
import { validateRequest } from './contract-support';
import { spawnProcessRunner, type ProcessRunner } from './process-runner';
import type { ContractEnvelope } from './contract-envelope';

export {
  providerExecutableSchemaVersion,
  type ContractEnvelope,
  type ContractErrorEnvelope,
  type ContractErrorObject,
  type ContractEvidence,
  type ContractSuccessEnvelope,
} from './contract-envelope';

export type ProviderExecutableCommand =
  | 'probe'
  | 'build-command'
  | 'parse-output'
  | 'classify-error'
  | 'invoke';

export interface ProviderExecutableResponse {
  readonly envelope: ContractEnvelope;
  readonly exitCode: number;
}

export interface ProviderExecutableOptions {
  readonly runner?: ProcessRunner;
  readonly runtimeSettings?: Record<string, unknown>;
}

export async function runProviderExecutable(
  input: string,
  options: ProviderExecutableOptions = {}
): Promise<ProviderExecutableResponse> {
  const fallback = requestEnvelopeData(input);
  try {
    const request = validateRequest(input, providerExecutableSchemaVersion);
    const envelope = await dispatchRequest(
      request,
      options.runner ?? spawnProcessRunner(),
      options.runtimeSettings
    );
    return {
      envelope: finalizeEnvelope(envelope, request.env),
      exitCode: 0,
    };
  } catch (error) {
    const requestError = requestErrorFromUnknown(error);
    return {
      envelope: finalizeEnvelope(fallbackErrorEnvelope(fallback, requestError), fallback.env),
      exitCode: requestError.exitCode,
    };
  }
}
