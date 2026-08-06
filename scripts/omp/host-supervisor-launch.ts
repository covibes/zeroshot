import { spawn, type ChildProcess } from 'node:child_process';

import type { SemanticOutcome } from './host-supervisor-cleanup';
import { installSupervisorProtection } from './host-supervisor-native';
import { promiseGate } from './promise-gate';

export function childOutcome(child: ChildProcess): Promise<SemanticOutcome> {
  const gate = promiseGate<SemanticOutcome>();
  child.once('error', (error) => gate.reject(error));
  child.once('close', (exitCode, signal) => gate.resolve({ exitCode, signal }));
  return gate.promise;
}

export async function launchProtectedSidecar(): Promise<void> {
  const supervisorPid = Number(process.argv[3]);
  const sidecarPath = process.argv[4];
  const requestPath = process.argv[5];
  if (
    !Number.isSafeInteger(supervisorPid) ||
    supervisorPid <= 1 ||
    sidecarPath === undefined ||
    requestPath === undefined
  ) {
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
