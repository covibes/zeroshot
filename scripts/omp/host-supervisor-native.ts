/// <reference path="./bun-ffi.d.ts" />

import { readFileSync, readdirSync } from 'node:fs';
import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';

export const PR_SET_DUMPABLE = 4;
export const PR_SET_SECCOMP = 22;
export const PR_SET_CHILD_SUBREAPER = 36;
export const PR_GET_CHILD_SUBREAPER = 37;
export const PR_SET_NO_NEW_PRIVS = 38;
export const SECCOMP_MODE_FILTER = 2;
export const SECCOMP_RET_ALLOW = 0x7fff0000;
export const SECCOMP_RET_ERRNO = 0x00050001;
export const BPF_LD_W_ABS = 0x20;
export const BPF_JMP_JEQ_K = 0x15;
export const BPF_JMP_JSET_K = 0x45;
export const BPF_RET_K = 0x06;
export const WNOHANG = 1;
export const ECHILD = 10;
export const ESRCH = 3;
export const SYS_PIDFD_SEND_SIGNAL = 424;
export const SYS_PIDFD_OPEN = 434;
export const EINTR = 4;
export const POLLIN = 0x0001;
export const POLLERR = 0x0008;
export const POLLHUP = 0x0010;
export const POLLNVAL = 0x0020;

interface FilterInstruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

export const libc = dlopen('libc.so.6', {
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
export const native = libc.symbols;
export function errno(): number {
  const address = native.__errno_location();
  return new Int32Array(toArrayBuffer(address, 0, 4))[0] ?? 0;
}

export function pidfdOpen(pid: number): number {
  return Number(native.syscall(SYS_PIDFD_OPEN, pid, 0, 0, 0, 0, 0));
}

export function pidfdSendSignal(pidfd: number, signal: number): number {
  return Number(native.syscall(SYS_PIDFD_SEND_SIGNAL, pidfd, signal, 0, 0, 0, 0));
}

export function pidfdAlive(pidfd: number): boolean {
  const result = pidfdSendSignal(pidfd, 0);
  if (result === 0) return true;
  if (errno() === ESRCH) return false;
  throw new Error('pidfd identity liveness probe failed');
}
export function installSupervisorProtection(supervisorPid: number): void {
  const profile =
    process.arch === 'x64'
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
    close < 0
      ? undefined
      : supervisorStat
          .slice(close + 2)
          .trim()
          .split(/\s+/)[2]
  );
  if (!Number.isSafeInteger(supervisorProcessGroup) || supervisorProcessGroup <= 1) {
    throw new Error('supervisor process-group identity unavailable');
  }
  const killTargets = [0xffffffff, -supervisorProcessGroup >>> 0, ...supervisorTids];
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
    instructions.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: block.length, k: syscall }, ...block);
  }
  for (const syscall of profile.schedulerControls) {
    instructions.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: syscall }, deny);
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
  if (
    native.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0 ||
    native.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ptr(program), 0, 0) !== 0
  ) {
    throw new Error('seccomp supervisor protection unavailable');
  }
}
