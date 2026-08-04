/// <reference path="./bun-ffi.d.ts" />

import { readFileSync, readdirSync } from 'node:fs';
import { ptr } from 'bun:ffi';

import {
  ECHILD,
  ESRCH,
  WNOHANG,
  errno,
  native,
  pidfdAlive,
  pidfdOpen,
  pidfdSendSignal,
} from './host-supervisor-native';

type StableIdentity = {
  pid: number;
  startTime: string;
  parentPid: number;
  parentStartTime: string;
  pidfd: number;
};

const identities = new Map<number, StableIdentity>();
let maxTrackedIdentities = 4_096;
let semanticRootPid: number | undefined;
let supervisorStartTime: string | undefined;

interface ProcIdentity {
  readonly state: string;
  readonly parentPid: number;
  readonly startTime: string;
}

export function processIdentity(pid: number): ProcIdentity | undefined {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = source.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = source
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    if (
      state === undefined ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      startTime === undefined
    )
      return undefined;
    return { state, parentPid, startTime };
  } catch {
    return undefined;
  }
}

export function processStartTime(pid: number): string | undefined {
  return processIdentity(pid)?.startTime;
}

function childPids(pid: number): number[] {
  const children = new Set<number>();
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  for (const task of tasks) {
    try {
      for (const token of readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8')
        .trim()
        .split(/\s+/)) {
        const childPid = Number(token);
        if (Number.isSafeInteger(childPid) && childPid > 1) children.add(childPid);
      }
    } catch {
      // A thread may exit between listing and reading; kernel child ownership remains authoritative.
    }
  }
  return [...children];
}

function openStableIdentity(
  pid: number,
  owner: {
    readonly pid: number;
    readonly startTime: string;
    readonly pidfd?: number;
  }
): StableIdentity | undefined {
  if (owner.pidfd !== undefined && !pidfdAlive(owner.pidfd)) return undefined;
  const ownerBefore = processIdentity(owner.pid);
  const before = processIdentity(pid);
  if (
    ownerBefore?.startTime !== owner.startTime ||
    before === undefined ||
    before.state === 'Z' ||
    before.parentPid !== owner.pid
  )
    return undefined;
  const pidfd = pidfdOpen(pid);
  if (pidfd < 0) {
    if (errno() === ESRCH && processIdentity(pid) === undefined) return undefined;
    throw new Error('pidfd_open unavailable for an owned process');
  }
  const ownerAfter = processIdentity(owner.pid);
  if (owner.pidfd !== undefined && !pidfdAlive(owner.pidfd)) {
    native.close(pidfd);
    return undefined;
  }
  const after = processIdentity(pid);
  if (
    ownerAfter?.startTime !== owner.startTime ||
    after?.startTime !== before.startTime ||
    after.state === 'Z' ||
    after.parentPid !== owner.pid
  ) {
    native.close(pidfd);
    return undefined;
  }
  return {
    pid,
    startTime: before.startTime,
    parentPid: owner.pid,
    parentStartTime: owner.startTime,
    pidfd,
  };
}

function retireExitedIdentities(): void {
  const status = new Int32Array(1);
  for (const identity of identities.values()) {
    if (identity.pid !== semanticRootPid) {
      const reaped = native.waitpid(identity.pid, ptr(status), WNOHANG);
      if (reaped < 0 && errno() !== ECHILD) {
        throw new Error('waitpid failed while retiring an owned identity');
      }
    }
    const probe = pidfdSendSignal(identity.pidfd, 0);
    if (probe < 0 && errno() === ESRCH) {
      native.close(identity.pidfd);
      identities.delete(identity.pid);
    } else if (probe < 0) {
      throw new Error('pidfd identity liveness probe failed');
    }
  }
}

export function discoverOwnedProcesses(): void {
  retireExitedIdentities();
  if (supervisorStartTime === undefined) throw new Error('supervisor identity unavailable');
  const queue: Array<{ pid: number; startTime: string; pidfd?: number }> = [
    { pid: process.pid, startTime: supervisorStartTime },
  ];
  for (const identity of identities.values()) {
    queue.push({
      pid: identity.pid,
      startTime: identity.startTime,
      pidfd: identity.pidfd,
    });
  }
  const visited = new Set<number>();
  while (queue.length > 0) {
    const owner = queue.shift();
    if (owner === undefined || visited.has(owner.pid)) continue;
    visited.add(owner.pid);
    if (processStartTime(owner.pid) !== owner.startTime) continue;
    if (owner.pidfd !== undefined && !pidfdAlive(owner.pidfd)) continue;
    for (const childPid of childPids(owner.pid)) {
      let identity = identities.get(childPid);
      if (identity !== undefined && processStartTime(childPid) !== identity.startTime) {
        native.close(identity.pidfd);
        identities.delete(childPid);
        identity = undefined;
      }
      if (identity === undefined) {
        if (identities.size >= maxTrackedIdentities) {
          throw new Error('owned process identity capacity exceeded');
        }
        identity = openStableIdentity(childPid, owner);
        if (identity !== undefined) identities.set(childPid, identity);
      }
      if (identity !== undefined) {
        queue.push({
          pid: identity.pid,
          startTime: identity.startTime,
          pidfd: identity.pidfd,
        });
      }
    }
  }
  retireExitedIdentities();
}

export function signalTracked(signal: number): void {
  for (const identity of identities.values()) {
    const result = pidfdSendSignal(identity.pidfd, signal);
    if (result < 0 && errno() === ESRCH) {
      native.close(identity.pidfd);
      identities.delete(identity.pid);
    } else if (result < 0) {
      throw new Error('pidfd_send_signal failed for an owned process');
    }
  }
}

export function signalOwned(signal: number): void {
  discoverOwnedProcesses();
  signalTracked(signal);
}

export function reapExitedOwned(rootPid: number): void {
  const status = new Int32Array(1);
  for (const identity of identities.values()) {
    if (identity.pid === rootPid) continue;
    const result = native.waitpid(identity.pid, ptr(status), WNOHANG);
    if (result < 0 && errno() !== ECHILD) {
      throw new Error('waitpid failed for an owned process');
    }
  }
}

export function ownershipEmpty(): boolean {
  const status = new Int32Array(1);
  for (;;) {
    const result = native.waitpid(-1, ptr(status), WNOHANG);
    if (result > 0) continue;
    if (result === 0) return false;
    if (errno() === ECHILD) return true;
    throw new Error('kernel child ownership could not be determined');
  }
}
export function initializeProcessTracker(startTime: string, identityCap: number): void {
  supervisorStartTime = startTime;
  maxTrackedIdentities = identityCap;
}

export function trackSemanticRoot(pid: number): boolean {
  semanticRootPid = pid;
  if (supervisorStartTime === undefined) throw new Error('supervisor identity unavailable');
  const rootIdentity = openStableIdentity(pid, {
    pid: process.pid,
    startTime: supervisorStartTime,
  });
  if (rootIdentity === undefined) return false;
  identities.set(rootIdentity.pid, rootIdentity);
  return true;
}

export function closeTrackedIdentities(): void {
  for (const identity of identities.values()) native.close(identity.pidfd);
  identities.clear();
}
