/**
 * Copy Worker - Worker thread for parallel file copying
 *
 * Handles copying a batch of files from source to destination.
 * Used by IsolationManager._copyDirExcluding() for parallel copying.
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const {
  createCopyBoundary,
  isCopyContainmentError,
  resolveCopyPath,
} = require('./copy-containment');

const { files, sourceBase, destBase, expectedBoundary } = workerData;
const copyBoundary = createCopyBoundary(sourceBase, destBase, expectedBoundary);

let copied = 0;
let skipped = 0;
let error = null;

for (const relativePath of files) {
  try {
    // Phase two creates every parent directory. Re-resolve the source and
    // destination immediately before the only worker filesystem effect.
    const { sourcePath, destinationPath } = resolveCopyPath(copyBoundary, relativePath);
    fs.copyFileSync(sourcePath, destinationPath);
    copied++;
  } catch (err) {
    // Skip files we can't copy (permission denied, broken symlinks, etc.)
    if (
      !isCopyContainmentError(err) &&
      (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOENT')
    ) {
      skipped++;
      continue;
    }
    error = {
      file: relativePath,
      name: err.name,
      code: err.code,
      message: err.message,
      relativePath: err.relativePath || relativePath,
    };
    break;
  }
}

// Report results back to main thread
parentPort.postMessage({ copied, skipped, error });
