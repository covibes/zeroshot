import { resolve } from 'node:path';
import { isRecord } from './json';

export const OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION = 1 as const;
export const OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES = 8 * 1024;

export interface OmpSdkSupervisorSemanticOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface OmpSdkSupervisorCleanAttestation {
  readonly protocolVersion: typeof OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION;
  readonly type: 'cleanup-attestation';
  readonly status: 'clean';
  readonly mode: 'linux-subreaper-pidfd';
  readonly subreaper: true;
  readonly pidfd: true;
  readonly terminalBuffered: true;
  readonly ownedProcessCount: 0;
  readonly cancelled: boolean;
  readonly semantic: OmpSdkSupervisorSemanticOutcome;
}

export interface OmpSdkSupervisorErrorAttestation {
  readonly protocolVersion: typeof OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION;
  readonly type: 'cleanup-attestation';
  readonly status: 'error';
  readonly code: 'capability-unavailable' | 'cleanup-uncertain' | 'invalid-invocation';
  readonly semanticStarted: boolean;
}

export type OmpSdkSupervisorAttestation =
  | OmpSdkSupervisorCleanAttestation
  | OmpSdkSupervisorErrorAttestation;


function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isExitCode(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255);
}

function isSignal(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^SIG[A-Z0-9]+$/u.test(value));
}

export function parseOmpSdkSupervisorAttestation(bytes: Buffer): OmpSdkSupervisorAttestation {
  if (bytes.byteLength === 0 || bytes.byteLength > OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES) {
    throw new Error('OMP SDK supervisor attestation size is invalid.');
  }
  const source = bytes.toString('utf8');
  if (!source.endsWith('\n') || source.slice(0, -1).includes('\n')) {
    throw new Error('OMP SDK supervisor must emit exactly one attestation frame.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(0, -1));
  } catch {
    throw new Error('OMP SDK supervisor attestation is malformed.');
  }
  if (!isRecord(parsed) || parsed.protocolVersion !== OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION ||
      parsed.type !== 'cleanup-attestation' || (parsed.status !== 'clean' && parsed.status !== 'error')) {
    throw new Error('OMP SDK supervisor attestation identity is invalid.');
  }
  if (parsed.status === 'error') {
    if (!hasExactKeys(parsed, ['protocolVersion', 'type', 'status', 'code', 'semanticStarted']) ||
        !['capability-unavailable', 'cleanup-uncertain', 'invalid-invocation'].includes(String(parsed.code)) ||
        typeof parsed.semanticStarted !== 'boolean') {
      throw new Error('OMP SDK supervisor error attestation is invalid.');
    }
    return parsed as unknown as OmpSdkSupervisorErrorAttestation;
  }
  if (!hasExactKeys(parsed, [
    'protocolVersion', 'type', 'status', 'mode', 'subreaper', 'pidfd',
    'terminalBuffered', 'ownedProcessCount', 'cancelled', 'semantic',
  ]) || parsed.mode !== 'linux-subreaper-pidfd' || parsed.subreaper !== true ||
      parsed.pidfd !== true || parsed.terminalBuffered !== true || parsed.ownedProcessCount !== 0 ||
      typeof parsed.cancelled !== 'boolean' || !isRecord(parsed.semantic) ||
      !hasExactKeys(parsed.semantic, ['exitCode', 'signal']) ||
      !isExitCode(parsed.semantic.exitCode) || !isSignal(parsed.semantic.signal) ||
      (parsed.semantic.exitCode === null) === (parsed.semantic.signal === null)) {
    throw new Error('OMP SDK supervisor clean attestation is invalid.');
  }
  return parsed as unknown as OmpSdkSupervisorCleanAttestation;
}

export function resolveOmpSdkHostSupervisorPath(): string {
  return resolve(__dirname, '..', '..', 'scripts', 'omp-sdk-host-supervisor.ts');
}
