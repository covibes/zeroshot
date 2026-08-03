import { buildAcpPrompt } from './adapters/acp';
import { buildOmpPrompt } from './adapters/omp';
import { runAcpStdioPrompt } from './acp-stdio-runner';
import { runOmpRpcTask } from './omp-rpc-driver';
import { ABORT_GRACE_MS, EXIT_GRACE_MS } from './omp-rpc-bounds';
import { OMP_SUPPORTED_VERSION } from './omp-release';
import { commandRedactions } from './contract-env';
import { successEnvelope, type ContractEnvelope } from './contract-envelope';
import {
  buildCommandSpec,
  optionalNumber,
  schemaMode,
  type RequestData,
} from './contract-support';
import { providerFailureClassification } from './invoke-evidence';
import { parseOutputEvents } from './contract-parse';
import { isRecord, unknownToMessage } from './json';
import { runOmpSdkProcess, type OmpSdkProcessResult } from './omp-sdk-process-runner';
import type { CommandSpec } from './types';
import type { ProcessResult, ProcessRunner, ProcessRunnerOptions } from './process-runner';

type UnknownFunction = (...args: unknown[]) => unknown;

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

function createCommandSpecCleanup(
  commandSpec: CommandSpec,
  logFailure: (path: string, error: unknown) => void
): { run: () => unknown } {
  const cleanupModule: unknown = require('../../src/command-cleanup-ownership');
  if (!isRecord(cleanupModule) || !isUnknownFunction(cleanupModule.createCommandSpecCleanup)) {
    throw new Error('src/command-cleanup-ownership must export createCommandSpecCleanup.');
  }
  const cleanup = cleanupModule.createCommandSpecCleanup(commandSpec, logFailure);
  if (!isRecord(cleanup) || !isUnknownFunction(cleanup.run)) {
    throw new Error('createCommandSpecCleanup() must return { run }.');
  }
  const runFn = cleanup.run;
  return { run: () => runFn() };
}

// No caller-supplied timeoutMs for the rpc-stdio lane means "no timeout"; the driver's
// OmpRpcTaskRequest.timeoutMs is required, so fall back to Node's max safe setTimeout delay
// (~24.8 days) rather than inventing a shorter implicit ceiling.
const NO_TIMEOUT_MS = 2_147_483_647;

interface CleanupResult {
  readonly path: string;
  readonly removed: boolean;
  readonly error?: string;
}

async function cleanupFiles(commandSpec: CommandSpec): Promise<readonly CleanupResult[]> {
  const paths = commandSpec.cleanup ?? [];
  if (paths.length === 0) return [];
  const failures = new Map<string, string>();
  const cleanup = createCommandSpecCleanup(commandSpec, (path: string, error: unknown) => {
    failures.set(path, unknownToMessage(error));
  });
  await cleanup.run();
  const planFailure = failures.get('<command-cleanup>');
  return paths.map((path) => {
    const error = planFailure ?? failures.get(path);
    return error === undefined ? { path, removed: true } : { path, removed: false, error };
  });
}

async function runAndCleanup(
  commandSpec: CommandSpec,
  runner: ProcessRunner,
  runnerOptions: ProcessRunnerOptions
): Promise<{ readonly result: ProcessResult; readonly cleanup: readonly CleanupResult[] }> {
  let result: ProcessResult | null = null;
  let runnerError: unknown;
  try {
    result = await runner(commandSpec, runnerOptions);
  } catch (error) {
    runnerError = error;
  }

  const cleanup = await cleanupFiles(commandSpec);
  if (runnerError !== undefined) throw runnerError;
  if (result === null) throw new Error('Provider runner did not produce a result.');
  return { result, cleanup };
}

async function runOmpRpcContractPrompt(
  commandSpec: CommandSpec,
  prompt: string,
  options: ProcessRunnerOptions = {}
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? NO_TIMEOUT_MS;
  const controller = new AbortController();
  const result = await runOmpRpcTask(
    {
      commandSpec,
      prompt,
      expectedVersion: OMP_SUPPORTED_VERSION,
      session: { kind: 'none' },
      signal: controller.signal,
      timeoutMs,
      abortGraceMs: ABORT_GRACE_MS,
      exitGraceMs: EXIT_GRACE_MS,
    },
    {
      onSpawn: async () => {},
      onEvent: async () => {},
      onSession: async () => {},
    }
  );
  const timedOut = result.stopReason === 'timeout';
  return {
    stdout: result.events.map((event) => JSON.stringify(event)).join('\n'),
    stderr: '',
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    timedOut,
    ...(timedOut ? { timeoutMs } : {}),
  };
}

export async function runInvoke(
  request: RequestData,
  runner: ProcessRunner
): Promise<ContractEnvelope> {
  const prepared = buildCommandSpec(request);
  const { adapter, commandSpec, context, options } = prepared;
  const timeoutMs = optionalNumber(request.raw, 'timeoutMs');
  const runnerOptions = timeoutMs === undefined ? {} : { timeoutMs };
  let result: ProcessResult;
  let cleanup: readonly CleanupResult[];
  if (prepared.invoke.parser === 'omp-sdk-ndjson') {
    const privateArtifacts = prepared.privateArtifacts;
    if (privateArtifacts === undefined) {
      throw new Error('OMP SDK prepared invocation is missing private artifact ownership.');
    }
    const sdkResult = await runOmpSdkProcess(prepared, runnerOptions);
    result = sdkResult;
    cleanup = [
      {
        path: privateArtifacts.root,
        removed: sdkResult.cleanupAttestation.clean,
      },
    ];
  } else {
    let invokeRunner: ProcessRunner;
    switch (prepared.invoke.lane) {
      case 'spawn':
        invokeRunner = runner;
        break;
      case 'acp-stdio':
        invokeRunner = (
          spec: CommandSpec,
          invokeOptions?: ProcessRunnerOptions
        ): Promise<ProcessResult> =>
          runAcpStdioPrompt(adapter.id, spec, buildAcpPrompt(context, options), invokeOptions);
        break;
      case 'rpc-stdio':
        invokeRunner = (
          spec: CommandSpec,
          invokeOptions?: ProcessRunnerOptions
        ): Promise<ProcessResult> =>
          runOmpRpcContractPrompt(spec, buildOmpPrompt(context, options), invokeOptions);
        break;
    }
    ({ result, cleanup } = await runAndCleanup(commandSpec, invokeRunner, runnerOptions));
  }
  const sdkResult = ompSdkResult(result);
  const parsed =
    sdkResult === null
      ? parseOutputEvents(adapter, {
          chunk: [result.stdout, result.stderr].join('\n'),
          sources: [
            { name: 'stdout', value: result.stdout },
            { name: 'stderr', value: result.stderr },
          ],
        })
      : {
          events: sdkResult.terminal.type === 'result' ? [sdkResult.terminal.event] : [],
          diagnostics: [],
        };
  const classification = providerFailureClassification(adapter, result, parsed.events);
  return successEnvelope({
    command: request.command ?? 'invoke',
    adapter,
    warnings: commandSpec.warnings,
    redactions: commandRedactions(commandSpec),
    evidence: invokeEvidence(result, timeoutMs),
    result: {
      commandSpec,
      outputFormat: options.outputFormat ?? null,
      schemaMode: schemaMode(options),
      evidence:
        sdkResult === null
          ? { stdout: result.stdout, stderr: result.stderr }
          : {
              stdout: '',
              stderr: sdkResult.diagnosticStderr,
              terminal: sdkResult.terminal.frame,
              progress: sdkResult.progress,
              cleanupAttestation: sdkResult.cleanupAttestation,
            },
      events: parsed.events,
      diagnostics: parsed.diagnostics,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut ?? false,
      timeoutMs: result.timeoutMs ?? timeoutMs ?? null,
      cleanup,
      classification,
    },
  });
}

function ompSdkResult(result: ProcessResult): OmpSdkProcessResult | null {
  return 'terminal' in result && 'cleanupAttestation' in result
    ? (result as OmpSdkProcessResult)
    : null;
}

function invokeEvidence(
  result: ProcessResult,
  timeoutMs: number | undefined
): Record<string, unknown> {
  const sdkResult = ompSdkResult(result);
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut ?? false,
    timeoutMs: result.timeoutMs ?? timeoutMs ?? null,
    ...(sdkResult === null
      ? {}
      : {
          terminal: sdkResult.terminal.frame,
          cleanupAttestation: sdkResult.cleanupAttestation,
        }),
  };
}
