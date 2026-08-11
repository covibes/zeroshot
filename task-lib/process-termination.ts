import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type TerminationStrategy = 'process' | 'process-group' | 'process-tree';
type TerminationSignal = 'SIGTERM' | 'SIGKILL';

type TerminationOwnership =
  | { readonly terminationStrategy: 'process-group'; readonly processGroupId: number }
  | {
      readonly terminationStrategy: 'process' | 'process-tree';
      readonly processGroupId: number | null;
    };

interface TerminationOptions {
  readonly terminationStrategy?: TerminationStrategy;
  readonly processGroupId?: number | null;
  readonly graceMs?: number;
  readonly hardKillWaitMs?: number;
  readonly pollMs?: number;
}

interface TerminationResult {
  readonly terminated: boolean;
  readonly alreadyDead: boolean;
  readonly escalated: boolean;
  readonly signal: TerminationSignal | null;
  readonly scope?: TerminationStrategy;
  readonly degraded?: boolean;
  readonly degradedReason?: string | null;
  readonly error?: string | null;
}

export function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTask(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTerminationOwnership(
  pid: number,
  options: TerminationOptions
): TerminationOwnership {
  const terminationStrategy = options.terminationStrategy || 'process';
  const processGroupId = Number(options.processGroupId) || null;

  if (terminationStrategy === 'process-group') {
    if (process.platform === 'win32') {
      throw new Error(
        'Process-group termination is unavailable on Windows; use terminationStrategy "process-tree"'
      );
    }
    if (!processGroupId || processGroupId !== pid) {
      throw new Error(
        `Refusing process-group termination for PID ${pid}: owned processGroupId must equal the provider root PID`
      );
    }
    return { terminationStrategy, processGroupId };
  }

  if (terminationStrategy === 'process-tree' && process.platform !== 'win32') {
    throw new Error(
      'Process-tree termination is only supported on Windows; use terminationStrategy ' +
        `"process-group" on ${process.platform}`
    );
  }

  if (!['process', 'process-tree'].includes(terminationStrategy)) {
    throw new Error(`Unsupported termination strategy: ${terminationStrategy}`);
  }

  return { terminationStrategy, processGroupId };
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessGroupRunning(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorHasCode(error, 'EPERM');
  }
}

export function isOwnedProcessTreeRunning(
  pid: number | null | undefined,
  options: TerminationOptions = {}
): boolean {
  if (!pid) return false;
  const ownership = normalizeTerminationOwnership(pid, options);
  if (ownership.terminationStrategy === 'process-group') {
    return isProcessGroupRunning(ownership.processGroupId);
  }
  return isProcessRunning(pid);
}

async function signalWindowsProcessTree(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  await execFileAsync('taskkill', args, { windowsHide: true });
}

async function signalOwnedProcessTree(
  pid: number,
  signal: TerminationSignal,
  ownership: TerminationOwnership
): Promise<void> {
  if (ownership.terminationStrategy === 'process-group') {
    process.kill(-ownership.processGroupId, signal);
    return;
  }
  if (ownership.terminationStrategy === 'process-tree') {
    await signalWindowsProcessTree(pid, signal === 'SIGKILL');
    return;
  }
  process.kill(pid, signal);
}

async function waitForOwnedProcessTreeExit(
  pid: number,
  ownership: TerminationOwnership,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const options: TerminationOptions = {
    terminationStrategy: ownership.terminationStrategy,
    processGroupId: ownership.processGroupId,
  };
  while (Date.now() < deadline) {
    if (!isOwnedProcessTreeRunning(pid, options)) return true;
    await sleep(pollMs);
  }
  return !isOwnedProcessTreeRunning(pid, options);
}

function terminationResult(
  ownership: TerminationOwnership,
  overrides: Partial<TerminationResult> = {}
): TerminationResult {
  const degraded = ownership.terminationStrategy === 'process';
  return {
    terminated: false,
    alreadyDead: false,
    escalated: false,
    signal: null,
    scope: ownership.terminationStrategy,
    degraded,
    degradedReason: degraded
      ? 'Task has no process-tree ownership metadata; only the provider root PID can be terminated'
      : null,
    ...overrides,
  };
}

async function signalAndWait(
  pid: number,
  ownership: TerminationOwnership,
  signal: TerminationSignal,
  timeoutMs: number,
  pollMs: number
): Promise<TerminationResult> {
  const escalated = signal === 'SIGKILL';
  try {
    await signalOwnedProcessTree(pid, signal, ownership);
  } catch (error) {
    if (
      !isOwnedProcessTreeRunning(pid, {
        terminationStrategy: ownership.terminationStrategy,
        processGroupId: ownership.processGroupId,
      })
    ) {
      return terminationResult(ownership, {
        terminated: true,
        alreadyDead: signal === 'SIGTERM',
        escalated,
        signal: escalated ? signal : null,
      });
    }
    return terminationResult(ownership, {
      escalated,
      signal,
      error: errorMessage(error),
    });
  }

  const terminated = await waitForOwnedProcessTreeExit(pid, ownership, timeoutMs, pollMs);
  return terminationResult(ownership, {
    terminated,
    escalated,
    signal,
    error:
      terminated || !escalated
        ? null
        : `Owned ${ownership.terminationStrategy} for PID ${pid} survived ${signal}`,
  });
}

/**
 * Terminate an owned provider process tree. Watchers create a dedicated process
 * group on POSIX and persist that ownership boundary; Windows uses taskkill /T.
 * Legacy tasks without ownership metadata fall back to root-only termination
 * and report the degraded scope explicitly.
 */
export async function terminateProcess(
  pid: number,
  options: TerminationOptions = {}
): Promise<TerminationResult> {
  let ownership: TerminationOwnership;
  try {
    ownership = normalizeTerminationOwnership(pid, options);
  } catch (error) {
    return {
      terminated: false,
      alreadyDead: false,
      escalated: false,
      signal: null,
      error: errorMessage(error),
    };
  }

  if (!isOwnedProcessTreeRunning(pid, options)) {
    return terminationResult(ownership, { terminated: true, alreadyDead: true });
  }

  const graceful = await signalAndWait(
    pid,
    ownership,
    'SIGTERM',
    options.graceMs ?? 5000,
    options.pollMs ?? 50
  );
  if (graceful.terminated || graceful.error) return graceful;

  return signalAndWait(
    pid,
    ownership,
    'SIGKILL',
    options.hardKillWaitMs ?? 1000,
    options.pollMs ?? 50
  );
}
