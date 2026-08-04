import { resolve } from 'node:path';
import { isRecord } from '../json';

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


function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareKeys);
  const keys = [...expected].sort(compareKeys);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isExitCode(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 255)
  );
}

function isSignal(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^SIG[A-Z0-9]+$/u.test(value));
}

function isSupervisorErrorCode(
  value: unknown
): value is OmpSdkSupervisorErrorAttestation['code'] {
  return (
    value === 'capability-unavailable' ||
    value === 'cleanup-uncertain' ||
    value === 'invalid-invocation'
  );
}

function isSupervisorSemanticOutcome(value: unknown): value is OmpSdkSupervisorSemanticOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['exitCode', 'signal']) ||
    !isExitCode(value.exitCode) ||
    !isSignal(value.signal)
  ) {
    return false;
  }
  return (value.exitCode === null) !== (value.signal === null);
}

function isSupervisorErrorAttestation(
  value: unknown
): value is OmpSdkSupervisorErrorAttestation {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'type', 'status', 'code', 'semanticStarted']) &&
    value.protocolVersion === OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION &&
    value.type === 'cleanup-attestation' &&
    value.status === 'error' &&
    isSupervisorErrorCode(value.code) &&
    typeof value.semanticStarted === 'boolean'
  );
}

function isSupervisorCleanAttestation(
  value: unknown
): value is OmpSdkSupervisorCleanAttestation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'protocolVersion',
      'type',
      'status',
      'mode',
      'subreaper',
      'pidfd',
      'terminalBuffered',
      'ownedProcessCount',
      'cancelled',
      'semantic',
    ]) &&
    value.protocolVersion === OMP_SDK_HOST_SUPERVISOR_PROTOCOL_VERSION &&
    value.type === 'cleanup-attestation' &&
    value.status === 'clean' &&
    value.mode === 'linux-subreaper-pidfd' &&
    value.subreaper === true &&
    value.pidfd === true &&
    value.terminalBuffered === true &&
    value.ownedProcessCount === 0 &&
    typeof value.cancelled === 'boolean' &&
    isSupervisorSemanticOutcome(value.semantic)
  );
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
    if (!isSupervisorErrorAttestation(parsed)) {
      throw new Error('OMP SDK supervisor error attestation is invalid.');
    }
    return parsed;
  }
  if (!isSupervisorCleanAttestation(parsed)) {
    throw new Error('OMP SDK supervisor clean attestation is invalid.');
  }
  return parsed;
}

export function resolveOmpSdkHostSupervisorPath(): string {
  return resolve(__dirname, '..', '..', '..', 'scripts', 'omp', 'host-supervisor.ts');
}
