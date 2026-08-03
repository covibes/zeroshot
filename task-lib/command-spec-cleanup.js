import { lstatSync, realpathSync, rmSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createCommandSpecCleanup: createBaseCommandSpecCleanup,
} = require('../src/command-cleanup-ownership');

const CLEANUP_METADATA_KEYS = ['kind', 'path', 'provider', 'reason'];
const OMP_SDK_ROOT_PATTERN = /^zeroshot-omp-sdk-[A-Za-z0-9_-]+$/u;

function isOmpSdkCleanupMetadata(metadata) {
  return (
    metadata?.kind === 'temp-directory' &&
    metadata.provider === 'omp' &&
    metadata.reason === 'sdk-private-root'
  );
}

function assertClosedCleanupMetadata(cleanupPath, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Refusing cleanup without closed ownership metadata: ${cleanupPath}`);
  }
  const keys = Object.keys(metadata).sort();
  if (
    keys.length !== CLEANUP_METADATA_KEYS.length ||
    keys.some((key, index) => key !== CLEANUP_METADATA_KEYS[index])
  ) {
    throw new Error(`Refusing cleanup with open ownership metadata: ${cleanupPath}`);
  }
  if (metadata.path !== cleanupPath) {
    throw new Error(`Refusing cleanup with mismatched ownership path: ${cleanupPath}`);
  }
}

function createSdkCleanupPlan(commandSpec) {
  if (!Array.isArray(commandSpec?.cleanup) || !Array.isArray(commandSpec?.cleanupMetadata)) {
    throw new Error('Refusing cleanup with malformed cleanup collections');
  }
  if (commandSpec.cleanup.length !== commandSpec.cleanupMetadata.length) {
    throw new Error('Refusing cleanup without one closed metadata receipt per path');
  }
  if (new Set(commandSpec.cleanup).size !== commandSpec.cleanup.length) {
    throw new Error('Refusing cleanup with duplicate cleanup paths');
  }

  const sdkPaths = new Set();
  const sdkEntries = [];
  for (const cleanupPath of commandSpec.cleanup) {
    if (typeof cleanupPath !== 'string' || cleanupPath.length === 0) {
      throw new Error('Refusing cleanup with a non-string or empty path');
    }
    const matches = commandSpec.cleanupMetadata.filter(
      (metadata) => metadata?.path === cleanupPath
    );
    if (matches.length !== 1) {
      throw new Error(`Refusing cleanup without exact ownership metadata: ${cleanupPath}`);
    }
    const metadata = matches[0];
    assertClosedCleanupMetadata(cleanupPath, metadata);
    if (isOmpSdkCleanupMetadata(metadata)) {
      sdkPaths.add(cleanupPath);
      sdkEntries.push({ cleanupPath, metadata });
    }
  }

  return {
    sdkEntries,
    baseCommandSpec: {
      ...commandSpec,
      cleanup: commandSpec.cleanup.filter((cleanupPath) => !sdkPaths.has(cleanupPath)),
      cleanupMetadata: commandSpec.cleanupMetadata.filter(
        (metadata) => !sdkPaths.has(metadata.path)
      ),
    },
  };
}

function sdkRootAlreadyAbsent(cleanupPath, metadata) {
  if (
    !isOmpSdkCleanupMetadata(metadata) ||
    !isAbsolute(cleanupPath) ||
    resolve(cleanupPath) !== cleanupPath ||
    dirname(cleanupPath) !== resolve(tmpdir()) ||
    !OMP_SDK_ROOT_PATTERN.test(basename(cleanupPath))
  ) {
    throw new Error(`Refusing unowned OMP SDK root cleanup: ${cleanupPath}`);
  }

  let stat;
  try {
    stat = lstatSync(cleanupPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  const realDirectory = realpathSync(cleanupPath);
  const ownedByProcess = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  const privateMode = process.platform === 'win32' || (stat.mode & 0o777) === 0o700;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !ownedByProcess ||
    !privateMode ||
    dirname(realDirectory) !== realpathSync(tmpdir()) ||
    basename(realDirectory) !== basename(cleanupPath)
  ) {
    throw new Error(`Refusing unowned OMP SDK root cleanup: ${cleanupPath}`);
  }
  return false;
}

function hasOmpSdkCleanup(commandSpec) {
  return (
    Array.isArray(commandSpec?.cleanupMetadata) &&
    commandSpec.cleanupMetadata.some(isOmpSdkCleanupMetadata)
  );
}

export function createCommandSpecCleanup(commandSpec, logFailure) {
  if (!hasOmpSdkCleanup(commandSpec)) {
    return createBaseCommandSpecCleanup(commandSpec, logFailure);
  }

  let started = false;
  let result = true;

  async function run() {
    if (started) return result;
    started = true;
    let plan;
    try {
      plan = createSdkCleanupPlan(commandSpec);
    } catch (error) {
      logFailure('<command-cleanup>', error);
      result = false;
      return result;
    }

    let succeeded = await createBaseCommandSpecCleanup(
      plan.baseCommandSpec,
      logFailure
    ).run();
    for (const { cleanupPath, metadata } of plan.sdkEntries) {
      try {
        if (!sdkRootAlreadyAbsent(cleanupPath, metadata)) {
          await rm(cleanupPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        succeeded = false;
        logFailure(cleanupPath, error);
      }
    }
    result = succeeded;
    return result;
  }

  function runSync() {
    if (started) return result;
    started = true;
    let plan;
    try {
      plan = createSdkCleanupPlan(commandSpec);
    } catch (error) {
      logFailure('<command-cleanup>', error);
      result = false;
      return result;
    }

    let succeeded = createBaseCommandSpecCleanup(
      plan.baseCommandSpec,
      logFailure
    ).runSync();
    for (const { cleanupPath, metadata } of plan.sdkEntries) {
      try {
        if (!sdkRootAlreadyAbsent(cleanupPath, metadata)) {
          rmSync(cleanupPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        succeeded = false;
        logFailure(cleanupPath, error);
      }
    }
    result = succeeded;
    return result;
  }

  return { run, runSync };
}
