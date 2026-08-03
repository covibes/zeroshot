import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error no declaration file for proper-lockfile
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_MIN_TIMEOUT_MS = 50;
const LOCK_RETRY_MAX_TIMEOUT_MS = 5_000;

export async function acquireTargetLock(targetId: string): Promise<() => Promise<void>> {
  const lockDir = path.join(os.homedir(), '.zeroshot');
  await fs.mkdir(lockDir, { recursive: true });

  const lockTarget = path.join(lockDir, `target-${targetId}.lock`);
  try {
    await fs.writeFile(lockTarget, '', { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const release = await lockfile.lock(lockTarget, {
    stale: LOCK_STALE_MS,
    retries: {
      retries: LOCK_RETRIES,
      minTimeout: LOCK_RETRY_MIN_TIMEOUT_MS,
      maxTimeout: LOCK_RETRY_MAX_TIMEOUT_MS,
    },
  });

  return release;
}
