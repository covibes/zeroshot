import { chmodSync, constants, copyFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export type OmpAuthStorageMode = 'environment' | 'broker' | 'none' | 'omp-home';

interface ClosableAuthStorage {
  close(): void;
}

interface BrokerCredentials {
  readonly token?: string | undefined;
  readonly url?: string | undefined;
}

interface OmpAuthStoragePolicyOptions<T extends ClosableAuthStorage> {
  readonly mode: OmpAuthStorageMode;
  readonly sourceDirectory?: unknown;
  readonly privateAgentDirectory: string;
  readonly privateDatabasePath: string;
  readonly brokerCachePath: string;
  readonly brokerCredentials?: BrokerCredentials;
  readonly sourceLabel: string;
  readonly createDatabase: (databasePath: string) => Promise<T>;
  readonly discoverBroker: (
    agentDirectory: string,
    options: { cachePath: string; sourceLabel: string }
  ) => Promise<T>;
}


/**
 * Snapshot only OMP's credential database. Configuration, broker token, and
 * other files in the source home are deliberately outside this policy.
 */
export function snapshotOmpAuthDatabase(
  sourceDirectory: unknown,
  privateDatabasePath: string
): void {
  if (typeof sourceDirectory !== 'string' || sourceDirectory.length === 0) {
    throw new Error('OMP local auth source must be a non-empty directory path');
  }
  const sourceDatabasePath = join(sourceDirectory, 'agent.db');
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceDatabasePath);
  } catch (error) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === 'ENOENT') {
      throw new Error(`OMP local auth source is missing agent.db at ${sourceDatabasePath}`);
    }
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`OMP local auth source must be a regular agent.db file at ${sourceDatabasePath}`);
  }
  copyFileSync(sourceDatabasePath, privateDatabasePath, constants.COPYFILE_EXCL);
  chmodSync(privateDatabasePath, 0o600);

  for (const suffix of ['-wal', '-shm']) {
    const sourceSidecar = `${sourceDatabasePath}${suffix}`;
    const privateSidecar = `${privateDatabasePath}${suffix}`;
    try {
      const sidecarStat = lstatSync(sourceSidecar);
      if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) {
        throw new Error(`OMP local auth source sidecar must be a regular file: ${sourceSidecar}`);
      }
      copyFileSync(sourceSidecar, privateSidecar, constants.COPYFILE_EXCL);
      chmodSync(privateSidecar, 0o600);
    } catch (error) {
      const code =
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }
}

/** Open auth through one fail-closed policy shared by diagnostics and execution. */
export async function openOmpAuthStorage<T extends ClosableAuthStorage>(
  options: OmpAuthStoragePolicyOptions<T>
): Promise<T> {
  if (options.mode === 'omp-home') {
    snapshotOmpAuthDatabase(options.sourceDirectory, options.privateDatabasePath);
    return options.createDatabase(options.privateDatabasePath);
  }
  if (options.mode !== 'broker') {
    return options.createDatabase(options.privateDatabasePath);
  }

  const url = options.brokerCredentials?.url;
  const token = options.brokerCredentials?.token;
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    throw new Error('OMP broker credentials are missing');
  }

  const previousUrl = process.env.OMP_AUTH_BROKER_URL;
  const previousToken = process.env.OMP_AUTH_BROKER_TOKEN;
  process.env.OMP_AUTH_BROKER_URL = url;
  process.env.OMP_AUTH_BROKER_TOKEN = token;
  try {
    return await options.discoverBroker(options.privateAgentDirectory, {
      cachePath: options.brokerCachePath,
      sourceLabel: options.sourceLabel,
    });
  } finally {
    if (previousUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
    else process.env.OMP_AUTH_BROKER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
    else process.env.OMP_AUTH_BROKER_TOKEN = previousToken;
  }
}
