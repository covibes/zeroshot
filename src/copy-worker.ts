/**
 * Copy Worker - Worker thread for parallel file copying
 *
 * Handles copying a batch of files from source to destination.
 * Used by IsolationManager._copyDirExcluding() for parallel copying.
 */
import fs = require('fs');
import path = require('path');
import { parentPort, workerData } from 'worker_threads';
interface CopyWorkerData {
  files: string[];
  sourceBase: string;
  destBase: string;
}
interface CopyError {
  file: string;
  error: string;
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
    typeof value.destBase === 'string'
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
const { files, sourceBase, destBase } = rawWorkerData;
let copied = 0;
let skipped = 0;
const errors: CopyError[] = [];
for (const relativePath of files) {
  const srcPath = path.join(sourceBase, relativePath);
  const destPath = path.join(destBase, relativePath);
  try {
    // Ensure parent directory exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    // Copy the file
    fs.copyFileSync(srcPath, destPath);
    copied++;
  } catch (error: unknown) {
    // Skip files we can't copy (permission denied, broken symlinks, etc.)
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
      skipped++;
      continue;
    }
    errors.push({ file: relativePath, error: errorMessage(error) });
  }
}
// Report results back to main thread
if (!parentPort) {
  throw new Error('copy worker requires a parent port');
}
parentPort.postMessage({ copied, skipped, errors });
