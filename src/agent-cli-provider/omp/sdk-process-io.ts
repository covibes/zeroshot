import type { ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  parseOmpSdkProtocolFrame,
  type OmpSdkCollectedTerminal,
  type OmpSdkSidecarRequest,
} from './sdk-protocol';
import { OmpSdkProcessRunnerError } from './sdk-process-private-runtime';

export const MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 250;
export const DEFAULT_REAP_TIMEOUT_MS = 2_000;
const TEST_IDENTITY_CAP_ENV = 'ZEROSHOT_OMP_TEST_IDENTITY_CAP';
export interface ChildOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
}

export function cancelledTerminal(request: OmpSdkSidecarRequest): OmpSdkCollectedTerminal {
  const frame = parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'error',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    error: { code: 'cancelled', category: 'cancelled', retryable: false, redacted: true },
  });
  if (frame.type !== 'error') throw new Error('cancelled terminal construction failed');
  return { type: 'error', frame };
}

export function childClose(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolveClose) => {
    const spawned = child.pid !== undefined;
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      if (!spawned) spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      resolveClose({ exitCode, signal, ...(spawnError === undefined ? {} : { spawnError }) });
    });
  });
}

export function credentialWriter(child: ChildProcess): Writable {
  const channel = child.stdio[3];
  if (!(channel instanceof Writable)) {
    throw new OmpSdkProcessRunnerError(
      'protocol-error',
      'OMP SDK credential channel was not created.'
    );
  }
  channel.on('error', () => {
    // Keep late peer-reset errors observed after the one-shot write callback from becoming uncaught.
  });
  return channel;
}

export async function writeCredentials(channel: Writable, payload: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      channel.once('error', rejectWrite);
      channel.end(payload, () => {
        channel.removeListener('error', rejectWrite);
        resolveWrite();
      });
    });
  } finally {
    payload.fill(0);
  }
}

export function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function testIdentityCapArgument(): readonly string[] {
  const source = process.env.NODE_ENV === 'test' ? process.env[TEST_IDENTITY_CAP_ENV] : undefined;
  if (source === undefined) return [];
  const cap = Number(source);
  if (!Number.isSafeInteger(cap) || cap < 8 || cap > 4_096) {
    throw new OmpSdkProcessRunnerError(
      'protocol-error',
      'OMP SDK private test identity cap is invalid.'
    );
  }
  return [String(cap)];
}
