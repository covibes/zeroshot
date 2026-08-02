import { buildAcpPrompt } from './adapters/acp';
import { buildOmpPrompt } from './adapters/omp';
import { runAcpStdioPrompt } from './acp-stdio-runner';
import { runOmpRpcTask } from './omp-rpc-driver';
import { ABORT_GRACE_MS, EXIT_GRACE_MS } from './omp-rpc-bounds';
import { OMP_SUPPORTED_VERSION } from './omp-release';
import { commandRedactions } from './contract-env';
import { successEnvelope, type ContractEnvelope } from './contract-envelope';
import { buildCommandSpec, optionalNumber, schemaMode, type RequestData } from './contract-support';
import { providerFailureClassification } from './invoke-evidence';
import { parseOutputEvents } from './contract-parse';
import { isRecord, unknownToMessage } from './json';
import { getProviderRegistryEntry } from './provider-registry';
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
  const { adapter, commandSpec, context, options } = buildCommandSpec(request);
  const timeoutMs = optionalNumber(request.raw, 'timeoutMs');
  const runnerOptions = timeoutMs === undefined ? {} : { timeoutMs };
  const invokeSpec = getProviderRegistryEntry(adapter.id).invoke;
  const invokeRunner: ProcessRunner =
    invokeSpec.lane === 'acp-stdio'
      ? (spec: CommandSpec, invokeOptions?: ProcessRunnerOptions): Promise<ProcessResult> =>
          runAcpStdioPrompt(adapter.id, spec, buildAcpPrompt(context, options), invokeOptions)
      : invokeSpec.lane === 'rpc-stdio'
        ? (spec: CommandSpec, invokeOptions?: ProcessRunnerOptions): Promise<ProcessResult> =>
            runOmpRpcContractPrompt(spec, buildOmpPrompt(context, options), invokeOptions)
        : runner;
  const { result, cleanup } = await runAndCleanup(commandSpec, invokeRunner, runnerOptions);
  const parsed = parseOutputEvents(adapter, {
    chunk: [result.stdout, result.stderr].join('\n'),
    sources: [
      { name: 'stdout', value: result.stdout },
      { name: 'stderr', value: result.stderr },
    ],
  });
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
      evidence: {
        stdout: result.stdout,
        stderr: result.stderr,
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

function invokeEvidence(
  result: ProcessResult,
  timeoutMs: number | undefined
): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut ?? false,
    timeoutMs: result.timeoutMs ?? timeoutMs ?? null,
  };
}
