import {
  discoverOwnedProcesses,
  ownershipEmpty,
  reapExitedOwned,
  signalOwned,
  signalTracked,
} from './host-supervisor-tracker';
import { promiseGate } from './promise-gate';

const DISCOVERY_INTERVAL_MS = 5;
const SIGTERM = 15;
const SIGKILL = 9;

export interface SemanticOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function delay(milliseconds: number): Promise<void> {
  const gate = promiseGate<void>();
  setTimeout(() => gate.resolve(), milliseconds);
  return gate.promise;
}

export async function awaitOutcome(
  outcome: Promise<SemanticOutcome>,
  deadline: number
): Promise<SemanticOutcome | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  const timeoutGate = promiseGate<undefined>();
  const timer = setTimeout(() => timeoutGate.resolve(undefined), remaining);
  try {
    return await Promise.race([outcome, timeoutGate.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupOwned(
  rootPid: number,
  outcomePromise: Promise<SemanticOutcome>,
  graceMs: number,
  reapTimeoutMs: number
): Promise<SemanticOutcome> {
  signalOwned(SIGTERM);
  const gracefulDeadline = Date.now() + graceMs;
  let outcome = await awaitOutcome(outcomePromise, gracefulDeadline);
  while (outcome === undefined && Date.now() < gracefulDeadline) {
    discoverOwnedProcesses();
    reapExitedOwned(rootPid);
    await delay(DISCOVERY_INTERVAL_MS);
    outcome = await awaitOutcome(
      outcomePromise,
      Math.min(gracefulDeadline, Date.now() + DISCOVERY_INTERVAL_MS)
    );
  }

  signalOwned(SIGKILL);
  const reapDeadline = Date.now() + reapTimeoutMs;
  let cleanupDeadlineExceeded = false;
  while (outcome === undefined) {
    discoverOwnedProcesses();
    signalOwned(SIGKILL);
    outcome = await awaitOutcome(outcomePromise, Date.now() + DISCOVERY_INTERVAL_MS);
    if (Date.now() >= reapDeadline) cleanupDeadlineExceeded = true;
  }
  for (;;) {
    discoverOwnedProcesses();
    signalOwned(SIGKILL);
    if (ownershipEmpty()) {
      if (cleanupDeadlineExceeded) {
        throw new Error('descendant cleanup exceeded its attestation deadline');
      }
      return outcome;
    }
    if (Date.now() >= reapDeadline) cleanupDeadlineExceeded = true;
    await delay(DISCOVERY_INTERVAL_MS);
  }
}
export async function holdOwnershipUntilEmpty(): Promise<void> {
  for (;;) {
    try {
      discoverOwnedProcesses();
    } catch {
      // Capacity/relationship transitions cannot suppress signals to known identities.
    }
    try {
      signalTracked(SIGKILL);
    } catch {
      // Pidfd signaling is retried while ownership is retained.
    }
    try {
      if (ownershipEmpty()) return;
    } catch {
      // Kernel ownership is retried until ECHILD is authoritative.
    }
    await delay(DISCOVERY_INTERVAL_MS);
  }
}
