import * as fs from 'node:fs';

import { classifyProviderError } from './adapters';
import { envRedactions, commandRedactions } from './contract-env';
import { contractError } from './contract-errors';
import {
  providerExecutableSchemaVersion,
  successEnvelope,
  type ContractEnvelope,
  type ContractEvidence,
} from './contract-envelope';
import { runInvoke } from './contract-invoke';
import { runParseOutput } from './contract-parse';
import {
  adapterForProvider,
  buildCommandSpec,
  schemaMode,
  type RequestData,
} from './contract-support';
import { extractErrorStatus, UnsupportedProviderCapabilityError } from './errors';
import { probeRuntimeProviderCli } from './single-agent-runtime';
import { getString, isRecord, unknownToMessage } from './json';
import type { ErrorClassification } from './types';
import type { ProcessRunner } from './process-runner';

function runBuildCommand(request: RequestData): ContractEnvelope {
  const prepared = buildCommandSpec(request);
  if (prepared.invoke.parser === 'omp-sdk-ndjson') {
    const privateRoot = prepared.privateArtifacts?.root;
    if (privateRoot !== undefined) fs.rmSync(privateRoot, { recursive: true, force: true });
    throw new UnsupportedProviderCapabilityError(
      'omp',
      'buildCommand',
      'OMP SDK invocations cannot be exported by build-command because invoke owns the private request, minimal environment, protocol, containment, and cleanup. Use invoke instead.'
    );
  }
  const { adapter, commandSpec, options } = prepared;
  const webSearch = {
    requested: options.webSearch === true,
    effective: options.webSearch === true && options.cliFeatures?.supportsWebSearch === true,
  };
  return successEnvelope({
    command: request.command ?? 'build-command',
    adapter,
    warnings: commandSpec.warnings,
    redactions: commandRedactions(commandSpec),
    evidence: {
      outputFormat: options.outputFormat ?? null,
      schemaMode: schemaMode(options),
      configuration: { webSearch },
    },
    result: {
      commandSpec,
      outputFormat: options.outputFormat ?? null,
      schemaMode: schemaMode(options),
      configuration: { webSearch },
    },
  });
}

function runProbe(request: RequestData): ContractEnvelope {
  const adapter = adapterForProvider(request.provider);
  const helpText = typeof request.raw.helpText === 'string' ? request.raw.helpText : null;
  const versionText = typeof request.raw.versionText === 'string' ? request.raw.versionText : '';
  const runtimeProbe =
    helpText === null
      ? probeRuntimeProviderCli(adapter.id)
      : probeRuntimeProviderCli(adapter.id, {
          available: true,
          helpText,
          versionText,
        });
  return successEnvelope({
    command: request.command ?? 'probe',
    adapter,
    redactions: envRedactions(request.env),
    result: {
      provider: {
        id: adapter.id,
        displayName: adapter.displayName,
        binary: adapter.binary,
      },
      contractVersion: providerExecutableSchemaVersion,
      adapterVersion: adapter.adapterVersion,
      available: runtimeProbe.available,
      helpText: runtimeProbe.helpText,
      versionText: runtimeProbe.versionText,
      capabilities: runtimeProbe.capabilities,
      configuration: runtimeProbe.configuration,
      credentials: adapter.credentialEnvKeys.map((key) => ({
        key,
        present: Boolean(request.env[key] ?? process.env[key]),
      })),
    },
  });
}

function categoryForClassification(classification: ErrorClassification, error: unknown): string {
  const status = extractErrorStatus(error);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  const message = unknownToMessage(error);
  if (/auth|api[_ -]?key|unauthorized|forbidden|permission/i.test(message)) return 'auth';
  if (/rate|429|quota|resource_exhausted/i.test(message)) return 'rate-limit';
  if (/schema|json|parse|format|malformed/i.test(message)) return 'schema';
  return classification.retryable ? 'retryable' : 'permanent';
}

function errorEvidence(error: unknown): ContractEvidence {
  const evidence: Record<string, unknown> = {
    message: unknownToMessage(error),
  };
  const status = extractErrorStatus(error);
  if (status !== null) evidence.status = status;
  if (isRecord(error)) {
    const code = getString(error, 'code');
    if (code !== null) evidence.code = code;
  }
  return evidence;
}

function runClassifyError(request: RequestData): ContractEnvelope {
  const adapter = adapterForProvider(request.provider);
  const error = request.raw.error;
  if (error === undefined) {
    throw contractError({
      code: 'missing-field',
      message: 'error is required.',
      exitCode: 2,
      field: 'error',
    });
  }
  const classification = classifyProviderError(adapter.id, error);
  return successEnvelope({
    command: request.command ?? 'classify-error',
    adapter,
    redactions: envRedactions(request.env),
    evidence: errorEvidence(error),
    result: {
      classification,
      category: categoryForClassification(classification, error),
      evidence: errorEvidence(error),
    },
  });
}

export function dispatchRequest(
  request: RequestData,
  runner: ProcessRunner
): ContractEnvelope | Promise<ContractEnvelope> {
  switch (request.command) {
    case 'probe':
      return runProbe(request);
    case 'build-command':
      return runBuildCommand(request);
    case 'parse-output':
      return runParseOutput(request);
    case 'classify-error':
      return runClassifyError(request);
    case 'invoke':
      return runInvoke(request, runner);
    default:
      throw contractError({
        code: 'unknown-command',
        message: `Unknown command: ${request.command ?? ''}.`,
        exitCode: 3,
        field: 'command',
      });
  }
}
