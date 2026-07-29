import { lstat, realpath, rm, unlink } from 'fs/promises';
import { lstatSync, realpathSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isCanonicalClaudeSettingsOverlayDirectory,
  isClaudeSettingsOverlayDirectory,
} = require('../src/worktree-claude-config');

const CLEANUP_METADATA_KEYS = ['kind', 'path', 'provider', 'reason'];
const SCHEMA_DIRECTORY_PATTERN = /^zeroshot-schema-[A-Za-z0-9_-]+$/u;
const SCHEMA_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

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

function createCleanupPlan(commandSpec) {
  if (!Array.isArray(commandSpec?.cleanup) || !Array.isArray(commandSpec?.cleanupMetadata)) {
    throw new Error('Refusing cleanup with malformed cleanup collections');
  }
  if (commandSpec.cleanup.length !== commandSpec.cleanupMetadata.length) {
    throw new Error('Refusing cleanup without one closed metadata receipt per path');
  }
  const uniquePaths = new Set(commandSpec.cleanup);
  if (uniquePaths.size !== commandSpec.cleanup.length) {
    throw new Error('Refusing cleanup with duplicate cleanup paths');
  }

  return commandSpec.cleanup.map((cleanupPath) => {
    if (typeof cleanupPath !== 'string' || cleanupPath.length === 0) {
      throw new Error('Refusing cleanup with a non-string or empty path');
    }
    const matches = commandSpec.cleanupMetadata.filter(
      (metadata) => metadata?.path === cleanupPath
    );
    if (matches.length !== 1) {
      throw new Error(`Refusing cleanup without exact ownership metadata: ${cleanupPath}`);
    }
    assertClosedCleanupMetadata(cleanupPath, matches[0]);
    return { cleanupPath, metadata: matches[0] };
  });
}

function assertOwnedTempDirectory(cleanupPath, metadata) {
  if (
    metadata.provider !== 'claude' ||
    metadata.reason !== 'settings-overlay' ||
    !isCanonicalClaudeSettingsOverlayDirectory(cleanupPath)
  ) {
    throw new Error(`Refusing unowned temporary directory cleanup: ${cleanupPath}`);
  }
  if (isClaudeSettingsOverlayDirectory(cleanupPath)) {
    return false;
  }
  try {
    lstatSync(cleanupPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  throw new Error(`Refusing unowned temporary directory cleanup: ${cleanupPath}`);
}

function assertCanonicalSchemaPath(cleanupPath, metadata) {
  if (
    metadata.kind !== 'temp-file' ||
    metadata.provider !== 'codex' ||
    metadata.reason !== 'output-schema' ||
    !isAbsolute(cleanupPath) ||
    resolve(cleanupPath) !== cleanupPath
  ) {
    throw new Error(`Refusing unowned output-schema cleanup: ${cleanupPath}`);
  }
  const schemaDirectory = dirname(cleanupPath);
  if (
    dirname(schemaDirectory) !== resolve(tmpdir()) ||
    !SCHEMA_DIRECTORY_PATTERN.test(basename(schemaDirectory)) ||
    !SCHEMA_FILE_PATTERN.test(basename(cleanupPath))
  ) {
    throw new Error(`Refusing non-canonical output-schema cleanup: ${cleanupPath}`);
  }
}

async function assertOwnedSchemaFile(cleanupPath, metadata) {
  assertCanonicalSchemaPath(cleanupPath, metadata);
  const schemaDirectory = dirname(cleanupPath);
  const [tempRoot, realSchemaDirectory, directoryStat, schemaStat] = await Promise.all([
    realpath(tmpdir()),
    realpath(schemaDirectory),
    lstat(schemaDirectory),
    lstat(cleanupPath),
  ]);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    dirname(realSchemaDirectory) !== tempRoot ||
    basename(realSchemaDirectory) !== basename(schemaDirectory) ||
    schemaStat.isSymbolicLink() ||
    !schemaStat.isFile()
  ) {
    throw new Error(`Refusing non-regular or escaped output-schema cleanup: ${cleanupPath}`);
  }
}

function assertOwnedSchemaFileSync(cleanupPath, metadata) {
  assertCanonicalSchemaPath(cleanupPath, metadata);
  const schemaDirectory = dirname(cleanupPath);
  const tempRoot = realpathSync(tmpdir());
  const realSchemaDirectory = realpathSync(schemaDirectory);
  const directoryStat = lstatSync(schemaDirectory);
  const schemaStat = lstatSync(cleanupPath);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    dirname(realSchemaDirectory) !== tempRoot ||
    basename(realSchemaDirectory) !== basename(schemaDirectory) ||
    schemaStat.isSymbolicLink() ||
    !schemaStat.isFile()
  ) {
    throw new Error(`Refusing non-regular or escaped output-schema cleanup: ${cleanupPath}`);
  }
}

async function removeCleanupPath(cleanupPath, metadata) {
  if (metadata.kind === 'temp-directory') {
    if (assertOwnedTempDirectory(cleanupPath, metadata)) return;
    await rm(cleanupPath, { recursive: true, force: true });
    return;
  }
  await assertOwnedSchemaFile(cleanupPath, metadata);
  await unlink(cleanupPath);
}

function removeCleanupPathSync(cleanupPath, metadata) {
  if (metadata.kind === 'temp-directory') {
    if (assertOwnedTempDirectory(cleanupPath, metadata)) return;
    rmSync(cleanupPath, { recursive: true, force: true });
    return;
  }
  assertOwnedSchemaFileSync(cleanupPath, metadata);
  unlinkSync(cleanupPath);
}

/**
 * Build one idempotent cleanup owner for a provider command. Callers may run it
 * only after the persisted provider termination boundary is terminal.
 */
export function createCommandSpecCleanup(commandSpec, logFailure) {
  let started = false;
  let result = true;

  return {
    async run() {
      if (started) return result;
      started = true;
      let cleanupPlan;
      try {
        cleanupPlan = createCleanupPlan(commandSpec);
      } catch (error) {
        logFailure('<command-cleanup>', error);
        result = false;
        return result;
      }
      let succeeded = true;
      for (const { cleanupPath, metadata } of cleanupPlan) {
        try {
          await removeCleanupPath(cleanupPath, metadata);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          succeeded = false;
          logFailure(cleanupPath, error);
        }
      }
      result = succeeded;
      return result;
    },
    runSync() {
      if (started) return result;
      started = true;
      let cleanupPlan;
      try {
        cleanupPlan = createCleanupPlan(commandSpec);
      } catch (error) {
        logFailure('<command-cleanup>', error);
        result = false;
        return result;
      }
      let succeeded = true;
      for (const { cleanupPath, metadata } of cleanupPlan) {
        try {
          removeCleanupPathSync(cleanupPath, metadata);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          succeeded = false;
          logFailure(cleanupPath, error);
        }
      }
      result = succeeded;
      return result;
    },
  };
}
