import { rm, unlink } from 'fs/promises';
import { rmSync, unlinkSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isClaudeSettingsOverlayDirectory } = require('../src/worktree-claude-config');

function cleanupMetadataByPath(commandSpec) {
  return new Map((commandSpec.cleanupMetadata || []).map((item) => [item.path, item]));
}

function assertOwnedTempDirectory(cleanupPath, metadata) {
  if (
    metadata.provider !== 'claude' ||
    metadata.reason !== 'settings-overlay' ||
    !isClaudeSettingsOverlayDirectory(cleanupPath)
  ) {
    throw new Error(`Refusing unowned temporary directory cleanup: ${cleanupPath}`);
  }
}

async function removeCleanupPath(cleanupPath, metadata) {
  if (metadata?.kind === 'temp-directory') {
    assertOwnedTempDirectory(cleanupPath, metadata);
    await rm(cleanupPath, { recursive: true, force: true });
    return;
  }
  await unlink(cleanupPath);
}

function removeCleanupPathSync(cleanupPath, metadata) {
  if (metadata?.kind === 'temp-directory') {
    assertOwnedTempDirectory(cleanupPath, metadata);
    rmSync(cleanupPath, { recursive: true, force: true });
    return;
  }
  unlinkSync(cleanupPath);
}

/**
 * Build one idempotent cleanup owner for a provider command. Callers may run it
 * only after the persisted provider termination boundary is terminal.
 */
export function createCommandSpecCleanup(commandSpec, logFailure) {
  const cleanupPaths = commandSpec.cleanup || [];
  const metadataByPath = cleanupMetadataByPath(commandSpec);
  let started = false;
  let result = true;

  return {
    async run() {
      if (started) return result;
      started = true;
      let succeeded = true;
      for (const cleanupPath of cleanupPaths) {
        try {
          await removeCleanupPath(cleanupPath, metadataByPath.get(cleanupPath));
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
      let succeeded = true;
      for (const cleanupPath of cleanupPaths) {
        try {
          removeCleanupPathSync(cleanupPath, metadataByPath.get(cleanupPath));
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
