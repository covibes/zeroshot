import { spawn, type ChildProcess } from 'node:child_process';
import { omitProcessControlEnv, omitUnsafeProviderEnv } from './env-safety';
import type { CommandSpec } from './types';

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 100;
const PROVIDER_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

export interface ProcessRunnerOptions {
  readonly timeoutMs?: number;
  readonly timeoutKillGraceMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut?: boolean;
  readonly timeoutMs?: number;
}

export type ProcessRunner = (
  commandSpec: CommandSpec,
  options?: ProcessRunnerOptions
) => Promise<ProcessResult>;

interface TimeoutState {
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  timeoutKill?: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

function clearTimeoutState(state: TimeoutState): void {
  if (state.timeout !== undefined) clearTimeout(state.timeout);
  if (state.timeoutKill !== undefined) clearTimeout(state.timeoutKill);
  state.removeAbortListener?.();
}

function armTermination(
  child: ChildProcess,
  options: ProcessRunnerOptions,
  state: TimeoutState,
  isSettled: () => boolean
): void {
  const terminate = (): void => {
    child.kill('SIGTERM');
    if (state.timeoutKill !== undefined) return;
    state.timeoutKill = setTimeout(() => {
      if (!isSettled()) child.kill('SIGKILL');
    }, options.timeoutKillGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS);
  };

  if (options.signal !== undefined) {
    const abort = (): void => terminate();
    options.signal.addEventListener('abort', abort, { once: true });
    state.removeAbortListener = (): void => options.signal?.removeEventListener('abort', abort);
    if (options.signal.aborted) terminate();
  }
  if (options.timeoutMs === undefined) return;
  state.timeout = setTimeout(() => {
    state.timedOut = true;
    terminate();
  }, options.timeoutMs);
}

function processResult(input: {
  readonly stdout: readonly Buffer[];
  readonly stderr: readonly Buffer[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: number;
  readonly state: TimeoutState;
  readonly timeoutMs?: number;
}): ProcessResult {
  return {
    stdout: Buffer.concat(input.stdout).toString('utf8'),
    stderr: Buffer.concat(input.stderr).toString('utf8'),
    exitCode: input.exitCode,
    signal: input.signal,
    durationMs: Date.now() - input.startedAt,
    timedOut: input.state.timedOut,
    ...(input.state.timedOut && input.timeoutMs !== undefined
      ? { timeoutMs: input.timeoutMs }
      : {}),
  };
}

function spawnOptions(commandSpec: CommandSpec): {
  readonly shell: false;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['ignore', 'pipe', 'pipe'];
  cwd?: string;
} {
  const options: {
    readonly shell: false;
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: ['ignore', 'pipe', 'pipe'];
    cwd?: string;
  } = {
    shell: false,
    env: { ...omitProcessControlEnv(process.env), ...omitUnsafeProviderEnv(commandSpec.env) },
    stdio: PROVIDER_STDIO,
  };
  if (commandSpec.cwd !== undefined) options.cwd = commandSpec.cwd;
  return options;
}

function attachOutputCollectors(
  child: ChildProcess,
  stdout: Buffer[],
  stderr: Buffer[]
): void {
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
}

export function spawnProcessRunner(): ProcessRunner {
  return (commandSpec, options = {}) =>
    new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(commandSpec.binary, [...commandSpec.args], spawnOptions(commandSpec));
      const timeoutState: TimeoutState = { timedOut: false };
      let settled = false;

      function settle(): boolean {
        if (settled) return false;
        settled = true;
        clearTimeoutState(timeoutState);
        return true;
      }

      attachOutputCollectors(child, stdout, stderr);
      child.once('error', (error) => {
        if (settle()) reject(error);
      });
      child.once('close', (exitCode, signal) => {
        if (settle()) {
          resolve(
            processResult({
              stdout,
              stderr,
              exitCode,
              signal,
              startedAt,
              state: timeoutState,
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            })
          );
        }
      });

      armTermination(child, options, timeoutState, () => settled);
    });
}
