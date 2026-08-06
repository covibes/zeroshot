import { spawn } from 'node:child_process';

import { omitProcessControlEnv, omitUnsafeProviderEnv } from '../env-safety';
import { MAX_STDERR_TAIL_BYTES } from './rpc-bounds';
import { OmpRpcProtocolError } from './rpc-protocol';
import { OmpRpcChannel } from './rpc-driver-channel';
import { OmpRpcDispatcher } from './rpc-driver-dispatch';
import {
  OmpRpcTaskFailure,
  createDriverState,
  type OmpRpcTaskHooks,
  type OmpRpcTaskRequest,
  type OmpRpcTaskResult,
} from './rpc-driver-state';
import type { OutputEvent } from '../types';

export function runOmpRpcTask(
  request: OmpRpcTaskRequest,
  hooks: OmpRpcTaskHooks
): Promise<OmpRpcTaskResult> {
  return new Promise<OmpRpcTaskResult>((resolvePromise, rejectPromise) => {
    const { commandSpec } = request;
    const state = createDriverState();
    const child = spawn(commandSpec.binary, [...commandSpec.args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(commandSpec.cwd === undefined ? {} : { cwd: commandSpec.cwd }),
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...omitProcessControlEnv(process.env), ...omitUnsafeProviderEnv(commandSpec.env) },
    });

    let abortTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    };
    const deriveStopReason = (): string => {
      const lastResult = [...state.events].reverse().find((event) => event.type === 'result');
      return lastResult?.type === 'result' && lastResult.success === false
        ? 'turn-failed'
        : 'completed';
    };
    const finish = (stopReason: string): void => {
      if (state.settled) return;
      state.settled = true;
      clearTimers();
      resolvePromise({
        events: state.events,
        text: state.textParts.join(''),
        session: { ...state.sessionEvidence, phase: 'terminal' },
        stopReason,
        exitCode: state.processExit?.exitCode ?? null,
        signal: state.processExit?.signal ?? null,
      });
    };
    const pushEvent = (event: OutputEvent): void => {
      state.events.push(event);
      if (event.type === 'text') state.textParts.push(event.text);
      void hooks.onEvent(event).catch(() => {});
    };
    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const terminateOwnedBoundary = (): void => {
      if (state.terminationStarted || child.pid === undefined || hasExited()) return;
      state.terminationStarted = true;
      const pid = child.pid;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
      setTimeout(() => {
        if (hasExited()) return;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-pid, 'SIGKILL');
        } catch {
          // Process may already be gone.
        }
      }, request.exitGraceMs);
    };
    const failPermanently = (stopReason: string, message: string): void => {
      if (state.terminal) return;
      state.terminal = true;
      state.pendingStopReason = stopReason;
      pushEvent({
        type: 'result',
        success: false,
        result: null,
        error: `${stopReason}: ${message}`,
      });
      terminateOwnedBoundary();
    };

    const spawnHookPromise = new Promise<void>((resolveSpawnHook) => {
      child.once('spawn', () => {
        const pid = child.pid;
        if (pid === undefined) {
          failPermanently('spawn-hook-failed', 'Process spawned without a pid.');
          resolveSpawnHook();
          return;
        }
        hooks
          .onSpawn({
            pid,
            processGroupId: process.platform === 'win32' ? null : pid,
            terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
          })
          .then(resolveSpawnHook, (error: unknown) => {
            failPermanently(
              'spawn-hook-failed',
              error instanceof Error ? error.message : String(error)
            );
            resolveSpawnHook();
          });
      });
    });

    const channel = new OmpRpcChannel(child, state);
    const agentEnd = (): void => {
      if (state.terminal) return;
      state.terminal = true;
      state.pendingStopReason = deriveStopReason();
      child.stdin.end();
      setTimeout(terminateOwnedBoundary, request.exitGraceMs);
    };
    const dispatcher = new OmpRpcDispatcher({
      request,
      hooks,
      state,
      channel,
      spawnHook: spawnHookPromise,
      pushEvent,
      fail: failPermanently,
      agentEnd,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of state.decoder.push(chunk, state.negotiatedV2))
          dispatcher.enqueue(frame);
      } catch (error) {
        if (error instanceof OmpRpcProtocolError) failPermanently(error.code, error.message);
        else
          failPermanently('decoder-error', error instanceof Error ? error.message : String(error));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_BYTES);
    });
    child.once('error', (error) => {
      if (state.settled) return;
      state.settled = true;
      clearTimers();
      rejectPromise(error);
    });
    child.once('close', (exitCode, signal) => {
      state.processExit = { exitCode, signal: signal ?? null };
      for (const command of state.pending.values()) {
        command.reject(
          new OmpRpcTaskFailure('process-closed', 'child process ended before a response arrived.')
        );
      }
      state.pending.clear();
      if (state.terminal) return finish(state.pendingStopReason ?? deriveStopReason());
      state.terminal = true;
      let detail: string;
      try {
        state.decoder.finish();
        detail = `OMP process exited (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'}) before a terminal RPC frame arrived.`;
      } catch (error) {
        detail = error instanceof OmpRpcProtocolError ? error.message : String(error);
      }
      if (state.stderrTail) detail += ` stderr: ${state.stderrTail}`;
      const stopReason = state.abortStopReason ?? 'stream-ended-before-terminal';
      pushEvent({
        type: 'result',
        success: false,
        result: null,
        error: `${stopReason}: ${detail}`,
      });
      finish(stopReason);
    });

    const beginAbort = (stopReason: string): void => {
      if (state.settled || state.terminal || state.abortStopReason !== null) return;
      state.abortStopReason = stopReason;
      channel.writeFrame({ id: 'zs-abort', type: 'abort' });
      abortTimer = setTimeout(() => {
        if (!state.terminal) terminateOwnedBoundary();
      }, request.abortGraceMs);
    };
    if (request.signal.aborted) beginAbort('cancelled');
    else request.signal.addEventListener('abort', () => beginAbort('cancelled'), { once: true });
    timeoutTimer = setTimeout(() => beginAbort('timeout'), request.timeoutMs);
  });
}
