/// <reference path="./bun-ffi.d.ts" />

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import { ptr } from 'bun:ffi';

import {
  awaitOutcome,
  cleanupOwned,
  holdOwnershipUntilEmpty,
  type SemanticOutcome,
} from './host-supervisor-cleanup';
import { childOutcome, launchProtectedSidecar } from './host-supervisor-launch';
import {
  EINTR,
  POLLERR,
  POLLHUP,
  POLLIN,
  POLLNVAL,
  PR_GET_CHILD_SUBREAPER,
  PR_SET_CHILD_SUBREAPER,
  PR_SET_DUMPABLE,
  errno,
  installSupervisorProtection,
  libc,
  native,
  pidfdOpen,
  pidfdSendSignal,
} from './host-supervisor-native';
import {
  closeTrackedIdentities,
  discoverOwnedProcesses,
  initializeProcessTracker,
  processIdentity,
  trackSemanticRoot,
} from './host-supervisor-tracker';
import { promiseGate } from './promise-gate';

const PROTOCOL_VERSION = 1;
const DISCOVERY_INTERVAL_MS = 5;
const DEFAULT_GRACE_MS = 250;
const DEFAULT_MAX_TRACKED_IDENTITIES = 4_096;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;

type SignalName = NodeJS.Signals | null;

let semanticStarted = false;
let cancellationRequested = false;
let trackingUncertain = false;
let supervisorStartTime: string | undefined;
let discoveryTimer: NodeJS.Timeout | undefined;
let ownerPidfd: number | undefined;
let ownerPollDescriptor: Buffer | undefined;
let semanticChild: ChildProcess | undefined;
const cancellationGate = promiseGate<void>();
const ownerPidAtStart = process.ppid;

function requestCancellation(): void {
  cancellationRequested = true;
  cancellationGate.resolve();
}

function emit(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorAttestation(
  code: 'capability-unavailable' | 'cleanup-uncertain' | 'invalid-invocation'
): void {
  emit({
    protocolVersion: PROTOCOL_VERSION,
    type: 'cleanup-attestation',
    status: 'error',
    code,
    semanticStarted,
  });
}

function assertCapability(): void {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('unsupported Linux supervisor platform');
  }
  const selfIdentity = processIdentity(process.pid);
  if (selfIdentity === undefined) throw new Error('supervisor process identity unavailable');
  supervisorStartTime = selfIdentity.startTime;
  if (native.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
    throw new Error('PR_SET_CHILD_SUBREAPER unavailable');
  }
  const observed = new Uint32Array(1);
  if (native.prctl(PR_GET_CHILD_SUBREAPER, ptr(observed), 0, 0, 0) !== 0 || observed[0] !== 1) {
    throw new Error('child subreaper state could not be attested');
  }
  if (native.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
    throw new Error('supervisor signal hardening unavailable');
  }
  const selfPidfd = pidfdOpen(process.pid);
  if (selfPidfd < 0) throw new Error('pidfd_open unavailable');
  try {
    if (pidfdSendSignal(selfPidfd, 0) !== 0) {
      throw new Error('pidfd_send_signal unavailable');
    }
  } finally {
    native.close(selfPidfd);
  }
  const ownerBefore = processIdentity(ownerPidAtStart);
  if (ownerPidAtStart <= 1 || ownerBefore === undefined) {
    throw new Error('parent process identity unavailable');
  }
  ownerPidfd = pidfdOpen(ownerPidAtStart);
  const ownerAfter = processIdentity(ownerPidAtStart);
  if (
    ownerPidfd < 0 ||
    ownerAfter?.startTime !== ownerBefore.startTime ||
    process.ppid !== ownerPidAtStart
  ) {
    if (ownerPidfd >= 0) native.close(ownerPidfd);
    ownerPidfd = undefined;
    throw new Error('parent pidfd ownership unavailable');
  }
  ownerPollDescriptor = Buffer.alloc(8);
  ownerPollDescriptor.writeInt32LE(ownerPidfd, 0);
  ownerPollDescriptor.writeInt16LE(POLLIN, 4);
}

function ownerProcessExited(): boolean {
  if (process.ppid !== ownerPidAtStart) return true;
  if (ownerPidfd === undefined || ownerPollDescriptor === undefined) {
    throw new Error('parent pidfd poll state unavailable');
  }
  ownerPollDescriptor.writeInt16LE(0, 6);
  const result = native.poll(ptr(ownerPollDescriptor), 1, 0);
  if (result < 0) {
    if (errno() === EINTR) return false;
    throw new Error('parent pidfd poll failed');
  }
  const events = ownerPollDescriptor.readInt16LE(6);
  return result > 0 && (events & (POLLIN | POLLERR | POLLHUP | POLLNVAL)) !== 0;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--launch-protected') {
    try {
      await launchProtectedSidecar();
    } catch {
      process.exitCode = 70;
    }
    return;
  }
  process.once('SIGTERM', requestCancellation);
  process.once('SIGINT', requestCancellation);
  try {
    assertCapability();
  } catch {
    errorAttestation('capability-unavailable');
    process.exitCode = 70;
    return;
  }
  if (process.argv[2] === '--probe') {
    try {
      installSupervisorProtection(ownerPidAtStart);
    } catch {
      errorAttestation('capability-unavailable');
      process.exitCode = 70;
      return;
    }
    emit({
      protocolVersion: PROTOCOL_VERSION,
      type: 'cleanup-attestation',
      status: 'clean',
      mode: 'linux-subreaper-pidfd',
      subreaper: true,
      pidfd: true,
      terminalBuffered: true,
      ownedProcessCount: 0,
      cancelled: false,
      semantic: { exitCode: 0, signal: null },
    });
    return;
  }
  const [sidecarPath, requestPath, graceSource, reapSource, identityCapSource] =
    process.argv.slice(2);
  const graceMs = Number(graceSource ?? DEFAULT_GRACE_MS);
  const reapTimeoutMs = Number(reapSource ?? DEFAULT_REAP_TIMEOUT_MS);
  const identityCap = Number(identityCapSource ?? DEFAULT_MAX_TRACKED_IDENTITIES);
  if (
    !sidecarPath ||
    !requestPath ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    !Number.isSafeInteger(reapTimeoutMs) ||
    reapTimeoutMs <= 0 ||
    !Number.isSafeInteger(identityCap) ||
    identityCap < 8 ||
    identityCap > DEFAULT_MAX_TRACKED_IDENTITIES
  ) {
    errorAttestation('invalid-invocation');
    process.exitCode = 64;
    return;
  }
  initializeProcessTracker(supervisorStartTime as string, identityCap);

  let outcomePromise: Promise<SemanticOutcome>;
  try {
    semanticChild = spawn(
      process.execPath,
      [
        process.argv[1] as string,
        '--launch-protected',
        String(process.pid),
        sidecarPath,
        requestPath,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        shell: false,
        stdio: ['ignore', 4, 'inherit', 3],
        windowsHide: true,
      }
    );
    semanticStarted = true;
    if (semanticChild.pid === undefined || semanticChild.pid <= 1) {
      throw new Error('semantic PID unavailable');
    }
    outcomePromise = childOutcome(semanticChild);
    if (!trackSemanticRoot(semanticChild.pid)) {
      const fastOutcome = await awaitOutcome(outcomePromise, Date.now() + 100);
      if (fastOutcome === undefined) throw new Error('semantic PID identity unavailable');
    }
    discoveryTimer = setInterval(() => {
      try {
        if (ownerProcessExited()) requestCancellation();
        discoverOwnedProcesses();
      } catch {
        trackingUncertain = true;
        requestCancellation();
        try {
          semanticChild?.kill('SIGTERM');
        } catch {
          // Cleanup remains fail-closed and cannot attest clean after tracking uncertainty.
        }
      }
    }, DISCOVERY_INTERVAL_MS);
    discoveryTimer.unref();
  } catch {
    if (semanticStarted) await holdOwnershipUntilEmpty();
    errorAttestation('cleanup-uncertain');
    process.exitCode = 70;
    return;
  }

  let outcome: SemanticOutcome | undefined;
  try {
    const first = await Promise.race([
      outcomePromise.then((value) => ({ kind: 'outcome' as const, value })),
      cancellationGate.promise.then(() => ({ kind: 'cancel' as const })),
    ]);
    if (first.kind === 'outcome') outcome = first.value;
    outcome = await cleanupOwned(
      semanticChild.pid as number,
      outcome === undefined ? outcomePromise : Promise.resolve(outcome),
      cancellationRequested ? graceMs : 0,
      reapTimeoutMs
    );
    if (trackingUncertain) throw new Error('owned process tracking became uncertain');
    emit({
      protocolVersion: PROTOCOL_VERSION,
      type: 'cleanup-attestation',
      status: 'clean',
      mode: 'linux-subreaper-pidfd',
      subreaper: true,
      pidfd: true,
      terminalBuffered: true,
      ownedProcessCount: 0,
      cancelled: cancellationRequested,
      semantic: outcome,
    });
  } catch {
    await holdOwnershipUntilEmpty();
    errorAttestation('cleanup-uncertain');
    process.exitCode = 70;
  } finally {
    clearInterval(discoveryTimer);
    process.removeListener('SIGTERM', requestCancellation);
    process.removeListener('SIGINT', requestCancellation);
    closeTrackedIdentities();
    if (ownerPidfd !== undefined) native.close(ownerPidfd);
    libc.close();
    try {
      closeSync(3);
    } catch {
      // Credential input may already be closed by the semantic child lifecycle.
    }
  }
}

void main();
