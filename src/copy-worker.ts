/**
 * Copy Worker - Worker thread for parallel file copying
 *
 * Handles copying a batch of files from source to destination.
 * Used by IsolationManager._copyDirExcluding() for parallel copying.
 */
import fs = require('fs');
import { parentPort, workerData } from 'worker_threads';
import { createCopyBoundary, isCopyContainmentError, resolveCopyPath } from './copy-containment';
import type { CopyBoundary } from './copy-containment';
interface CopyWorkerData {
  files: string[];
  sourceBase: string;
  destBase: string;
  expectedBoundary: CopyBoundary;
}
interface CopyError {
  file: string;
  name: string;
  code: string | null;
  message: string;
  relativePath: unknown;
}
function isCopyWorkerData(value: unknown): value is CopyWorkerData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'files' in value &&
    Array.isArray(value.files) &&
    value.files.every((entry: unknown) => typeof entry === 'string') &&
    'sourceBase' in value &&
    typeof value.sourceBase === 'string' &&
    'destBase' in value &&
    typeof value.destBase === 'string' &&
    'expectedBoundary' in value &&
    typeof value.expectedBoundary === 'object' &&
    value.expectedBoundary !== null
  );
}
function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : null;
  }
  return null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const rawWorkerData: unknown = workerData;
if (!isCopyWorkerData(rawWorkerData)) {
  throw new TypeError('copy worker requires files, sourceBase, and destBase');
}
const { files, sourceBase, destBase, expectedBoundary } = rawWorkerData;
const copyBoundary = createCopyBoundary(sourceBase, destBase, expectedBoundary);
let copied = 0;
let skipped = 0;
let error: CopyError | null = null;
for (const relativePath of files) {
  try {
    // Phase two creates every parent directory. Re-resolve the source and
    // destination immediately before the only worker filesystem effect.
    const { sourcePath, destinationPath } = resolveCopyPath(copyBoundary, relativePath);
    fs.copyFileSync(sourcePath, destinationPath);
    copied++;
  } catch (caughtError: unknown) {
    // Skip files we can't copy (permission denied, broken symlinks, etc.)
    const code = errorCode(caughtError);
    if (
      !isCopyContainmentError(caughtError) &&
      (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT')
    ) {
      skipped++;
      continue;
    }
    error = {
      file: relativePath,
      name: caughtError instanceof Error ? caughtError.name : 'Error',
      code,
      message: errorMessage(caughtError),
      relativePath:
        typeof caughtError === 'object' && caughtError !== null && 'relativePath' in caughtError
          ? caughtError.relativePath
          : relativePath,
    };
    break;
  }
}
// Report results back to main thread
if (!parentPort) {
  throw new Error('copy worker requires a parent port');
}
parentPort.postMessage({ copied, skipped, error });
