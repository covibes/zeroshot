import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, readFileSync, readdirSync } from 'node:fs';
import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';

const PROTOCOL_VERSION = 1;
const PR_SET_DUMPABLE = 4;
const PR_SET_SECCOMP = 22;
const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;
const PR_SET_NO_NEW_PRIVS = 38;
const SECCOMP_MODE_FILTER = 2;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050001;
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const WNOHANG = 1;
const ECHILD = 10;
const ESRCH = 3;
const SYS_PIDFD_SEND_SIGNAL = 424;
const SYS_PIDFD_OPEN = 434;
const EINTR = 4;
const POLLIN = 0x0001;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const POLLNVAL = 0x0020;
const SIGTERM = 15;
const SIGKILL = 9;
const DISCOVERY_INTERVAL_MS = 5;
const DEFAULT_GRACE_MS = 250;
const DEFAULT_MAX_TRACKED_IDENTITIES = 4_096;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;

type SignalName = NodeJS.Signals | null;
type StableIdentity = {
  pid: number;
  startTime: string;
  parentPid: number;
  parentStartTime: string;
  pidfd: number;
};
interface FilterInstruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

const libc = dlopen('libc.so.6', {
  prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
  syscall: {
    args: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'],
    returns: 'i64',
  },
  waitpid: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  close: { args: ['i32'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
  poll: { args: ['ptr', 'u64', 'i32'], returns: 'i32' },
});
const native = libc.symbols;
const identities = new Map<number, StableIdentity>();
let maxTrackedIdentities = DEFAULT_MAX_TRACKED_IDENTITIES;
let semanticStarted = false;
let cancellationRequested = false;
let trackingUncertain = false;
let semanticRootPid: number | undefined;
let supervisorStartTime: string | undefined;
let discoveryTimer: NodeJS.Timeout | undefined;
let ownerPidfd: number | undefined;
let ownerPollDescriptor: Buffer | undefined;
let semanticChild: ChildProcess | undefined;
const cancellationGate = Promise.withResolvers<void>();
const ownerPidAtStart = process.ppid;

function requestCancellation(): void {
  cancellationRequested = true;
  cancellationGate.resolve();
}

function errno(): number {
  const address = native.__errno_location();
  return new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0;
}

function pidfdOpen(pid: number): number {
  return Number(native.syscall(SYS_PIDFD_OPEN, pid, 0, 0, 0, 0, 0));
}

function pidfdSendSignal(pidfd: number, signal: number): number {
  return Number(native.syscall(SYS_PIDFD_SEND_SIGNAL, pidfd, signal, 0, 0, 0, 0));
}

function pidfdAlive(pidfd: number): boolean {
  const result = pidfdSendSignal(pidfd, 0);
  if (result === 0) return true;
  if (errno() === ESRCH) return false;
  throw new Error('pidfd identity liveness probe failed');
}
function installSupervisorProtection(supervisorPid: number): void {
  const profile = process.arch === 'x64'
    ? {
        auditArch: 0xc000003e,
        kill: 62,
        tkill: 200,
        tgkill: 234,
        rtSigqueueinfo: 129,
        rtTgsigqueueinfo: 297,
        prlimit64: 302,
        schedulerControls: [141, 142, 144, 203, 251, 314],
      }
    : {
        auditArch: 0xc00000b7,
        kill: 129,
        tkill: 130,
        tgkill: 131,
        rtSigqueueinfo: 138,
        rtTgsigqueueinfo: 240,
        prlimit64: 261,
        schedulerControls: [140, 118, 119, 122, 30, 274],
      };
  const allow: FilterInstruction = { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW };
  const deny: FilterInstruction = { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO };
  const exactTarget = (): FilterInstruction[] => [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 16 },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: supervisorPid },
    allow,
    deny,
  ];
  const supervisorTids = readdirSync(`/proc/${supervisorPid}/task`)
    .map(Number)
    .filter((tid) => Number.isSafeInteger(tid) && tid > 1);
  if (!supervisorTids.includes(supervisorPid) || supervisorTids.length > 240) {
    throw new Error('supervisor thread identities unavailable');
  }
  const exactThreadTarget: FilterInstruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 16 },
    ...supervisorTids.map((tid, index) => ({
      code: BPF_JMP_JEQ_K,
      jt: supervisorTids.length - index,
      jf: 0,
      k: tid,
    })),
    allow,
    deny,
  ];
  const supervisorStat = readFileSync(`/proc/${supervisorPid}/stat`, 'utf8');
  const close = supervisorStat.lastIndexOf(')');
  const supervisorProcessGroup = Number(
    close < 0 ? undefined : supervisorStat.slice(close + 2).trim().split(/\s+/)[2]
  );
  if (!Number.isSafeInteger(supervisorProcessGroup) || supervisorProcessGroup <= 1) {
    throw new Error('supervisor process-group identity unavailable');
  }
  const killTargets = [
    0xffffffff,
    (-supervisorProcessGroup) >>> 0,
    ...supervisorTids,
  ];
  const killTarget: FilterInstruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 16 },
    ...killTargets.map((target, index) => ({
      code: BPF_JMP_JEQ_K,
      jt: killTargets.length - index,
      jf: 0,
      k: target,
    })),
    allow,
    deny,
  ];
  const instructions: FilterInstruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: profile.auditArch },
    deny,
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
    { code: BPF_JMP_JSET_K, jt: 0, jf: 1, k: 0x40000000 },
    deny,
  ];
  for (const [syscall, block] of [
    [profile.kill, killTarget],
    [profile.tkill, [deny]],
    [profile.tgkill, exactTarget()],
    [profile.rtSigqueueinfo, exactThreadTarget],
    [profile.rtTgsigqueueinfo, exactTarget()],
    [profile.prlimit64, exactThreadTarget],
    [SYS_PIDFD_OPEN, exactThreadTarget],
  ] as const) {
    instructions.push(
      { code: BPF_JMP_JEQ_K, jt: 0, jf: block.length, k: syscall },
      ...block
    );
  }
  for (const syscall of profile.schedulerControls) {
    instructions.push(
      { code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: syscall },
      deny
    );
  }
  instructions.push(allow);

  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    filter.writeUInt16LE(instruction.code, offset);
    filter.writeUInt8(instruction.jt, offset + 2);
    filter.writeUInt8(instruction.jf, offset + 3);
    filter.writeUInt32LE(instruction.k >>> 0, offset + 4);
  });
  const program = Buffer.alloc(16);
  program.writeUInt16LE(instructions.length, 0);
  program.writeBigUInt64LE(BigInt(ptr(filter)), 8);
  if (native.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0 ||
      native.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ptr(program), 0, 0) !== 0) {
    throw new Error('seccomp supervisor protection unavailable');
  }
}

interface ProcIdentity {
  readonly state: string;
  readonly parentPid: number;
  readonly startTime: string;
}

function processIdentity(pid: number): ProcIdentity | undefined {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = source.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = source.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    if (state === undefined || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
        startTime === undefined) return undefined;
    return { state, parentPid, startTime };
  } catch {
    return undefined;
  }
}

function processStartTime(pid: number): string | undefined {
  return processIdentity(pid)?.startTime;
}

function emit(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorAttestation(code: 'capability-unavailable' | 'cleanup-uncertain' | 'invalid-invocation'): void {
  emit({ protocolVersion: PROTOCOL_VERSION, type: 'cleanup-attestation', status: 'error', code, semanticStarted });
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
      for (const token of readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/)) {
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
  if (ownerBefore?.startTime !== owner.startTime || before === undefined ||
      before.state === 'Z' || before.parentPid !== owner.pid) return undefined;
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
  if (ownerAfter?.startTime !== owner.startTime ||
      after?.startTime !== before.startTime || after.state === 'Z' ||
      after.parentPid !== owner.pid) {
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

function discoverOwnedProcesses(): void {
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

function signalTracked(signal: number): void {
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

function signalOwned(signal: number): void {
  discoverOwnedProcesses();
  signalTracked(signal);
}

function reapExitedOwned(rootPid: number): void {
  const status = new Int32Array(1);
  for (const identity of identities.values()) {
    if (identity.pid === rootPid) continue;
    const result = native.waitpid(identity.pid, ptr(status), WNOHANG);
    if (result < 0 && errno() !== ECHILD) {
      throw new Error('waitpid failed for an owned process');
    }
  }
}

function ownershipEmpty(): boolean {
  const status = new Int32Array(1);
  for (;;) {
    const result = native.waitpid(-1, ptr(status), WNOHANG);
    if (result > 0) continue;
    if (result === 0) return false;
    if (errno() === ECHILD) return true;
    throw new Error('kernel child ownership could not be determined');
  }
}

function delay(milliseconds: number): Promise<void> {
  const gate = Promise.withResolvers<void>();
  setTimeout(gate.resolve, milliseconds);
  return gate.promise;
}

function childOutcome(child: ChildProcess): Promise<SemanticOutcome> {
  const gate = Promise.withResolvers<SemanticOutcome>();
  child.once('error', gate.reject);
  child.once('close', (exitCode, signal) => gate.resolve({ exitCode, signal }));
  return gate.promise;
}

async function awaitOutcome(
  outcome: Promise<SemanticOutcome>,
  deadline: number
): Promise<SemanticOutcome | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  const timeoutGate = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => timeoutGate.resolve(undefined), remaining);
  try {
    return await Promise.race([outcome, timeoutGate.promise]);
  } finally {
    clearTimeout(timer);
  }
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
  if (ownerPidfd < 0 || ownerAfter?.startTime !== ownerBefore.startTime ||
      process.ppid !== ownerPidAtStart) {
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

async function cleanupOwned(
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
async function holdOwnershipUntilEmpty(): Promise<void> {
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


async function launchProtectedSidecar(): Promise<void> {
  const supervisorPid = Number(process.argv[3]);
  const sidecarPath = process.argv[4];
  const requestPath = process.argv[5];
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 1 ||
      sidecarPath === undefined || requestPath === undefined) {
    process.exitCode = 64;
    return;
  }
  installSupervisorProtection(supervisorPid);
  const child = spawn(process.execPath, [sidecarPath, requestPath], {
    cwd: process.cwd(),
    detached: false,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit', 3],
    windowsHide: true,
  });
  const outcome = await childOutcome(child);
  process.exitCode = outcome.exitCode ?? 128;
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
    emit({ protocolVersion: PROTOCOL_VERSION, type: 'cleanup-attestation', status: 'clean', mode: 'linux-subreaper-pidfd', subreaper: true, pidfd: true, terminalBuffered: true, ownedProcessCount: 0, cancelled: false, semantic: { exitCode: 0, signal: null } });
    return;
  }
  const [sidecarPath, requestPath, graceSource, reapSource, identityCapSource] = process.argv.slice(2);
  const graceMs = Number(graceSource ?? DEFAULT_GRACE_MS);
  const reapTimeoutMs = Number(reapSource ?? DEFAULT_REAP_TIMEOUT_MS);
  const identityCap = Number(identityCapSource ?? DEFAULT_MAX_TRACKED_IDENTITIES);
  if (!sidecarPath || !requestPath || !Number.isSafeInteger(graceMs) || graceMs < 0 ||
      !Number.isSafeInteger(reapTimeoutMs) || reapTimeoutMs <= 0 ||
      !Number.isSafeInteger(identityCap) || identityCap < 8 ||
      identityCap > DEFAULT_MAX_TRACKED_IDENTITIES) {
    errorAttestation('invalid-invocation');
    process.exitCode = 64;
    return;
  }
  maxTrackedIdentities = identityCap;

  let outcomePromise: Promise<SemanticOutcome>;
  try {
    semanticChild = spawn(process.execPath, [
      process.argv[1] as string,
      '--launch-protected',
      String(process.pid),
      sidecarPath,
      requestPath,
    ], {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      shell: false,
      stdio: ['ignore', 4, 'inherit', 3],
      windowsHide: true,
    });
    semanticStarted = true;
    if (semanticChild.pid === undefined || semanticChild.pid <= 1) {
      throw new Error('semantic PID unavailable');
    }
    semanticRootPid = semanticChild.pid;
    outcomePromise = childOutcome(semanticChild);
    const rootIdentity = openStableIdentity(semanticChild.pid, {
      pid: process.pid,
      startTime: supervisorStartTime as string,
    });
    if (rootIdentity === undefined) {
      const fastOutcome = await awaitOutcome(outcomePromise, Date.now() + 100);
      if (fastOutcome === undefined) throw new Error('semantic PID identity unavailable');
    } else {
      identities.set(rootIdentity.pid, rootIdentity);
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
    for (const identity of identities.values()) native.close(identity.pidfd);
    if (ownerPidfd !== undefined) native.close(ownerPidfd);
    identities.clear();
    libc.close();
    try {
      closeSync(3);
    } catch {
      // Credential input may already be closed by the semantic child lifecycle.
    }
  }
}

await main();
