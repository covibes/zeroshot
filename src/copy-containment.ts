import fs = require('fs');
import path = require('path');

export const CONTAINMENT_ERROR_CODE = 'ERR_COPY_CONTAINMENT';

export interface PinnedCopyRoot {
  requestedPath: string;
  canonicalPath: string;
  device: string;
  inode: string;
}

export interface CopyBoundary {
  sourceRoot: PinnedCopyRoot;
  destinationRoot: PinnedCopyRoot;
}

interface PathIdentity {
  device: string;
  inode: string;
  directory: boolean;
}

export class CopyContainmentError extends Error {
  readonly code = CONTAINMENT_ERROR_CODE;
  readonly relativePath: unknown;

  constructor(relativePath: unknown, reason: string) {
    super(`Copy containment violation for ${JSON.stringify(relativePath)}: ${reason}`);
    this.name = 'CopyContainmentError';
    this.relativePath = relativePath;
  }
}

function isContained(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function containmentError(
  relativePath: unknown,
  reason: string,
  cause?: unknown
): CopyContainmentError {
  const error = new CopyContainmentError(relativePath, reason);
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : null;
  }
  return null;
}

function statIdentity(targetPath: string): PathIdentity {
  const stats = fs.statSync(targetPath, { bigint: true });
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    directory: stats.isDirectory(),
  };
}

function pinRoot(
  rootPath: string,
  label: string,
  expectedRoot?: PinnedCopyRoot
): PinnedCopyRoot {
  const requestedPath = path.resolve(rootPath);
  const canonicalPath = fs.realpathSync.native(requestedPath);
  const identity = statIdentity(canonicalPath);

  if (!identity.directory) {
    throw containmentError('', `${label} root is not a directory`);
  }

  const pinnedRoot = {
    requestedPath,
    canonicalPath,
    device: identity.device,
    inode: identity.inode,
  };

  if (
    expectedRoot &&
    (expectedRoot.canonicalPath !== pinnedRoot.canonicalPath ||
      expectedRoot.device !== pinnedRoot.device ||
      expectedRoot.inode !== pinnedRoot.inode)
  ) {
    throw containmentError('', `${label} root changed after it was pinned`);
  }

  return pinnedRoot;
}

function assertPinnedRoot(root: PinnedCopyRoot, label: string, relativePath: string): void {
  let identity: PathIdentity;
  try {
    identity = statIdentity(root.canonicalPath);
  } catch (error: unknown) {
    throw containmentError(relativePath, `${label} root can no longer be resolved`, error);
  }

  if (identity.device !== root.device || identity.inode !== root.inode || !identity.directory) {
    throw containmentError(relativePath, `${label} root changed after it was pinned`);
  }
}

export function validateRelativePath(relativePath: unknown): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw containmentError(relativePath, 'path must be a non-empty relative string');
  }
  if (relativePath.includes('\0')) {
    throw containmentError(relativePath, 'path contains a null byte');
  }
  if (path.isAbsolute(relativePath) || path.parse(relativePath).root) {
    throw containmentError(relativePath, 'absolute paths are not allowed');
  }

  const components = relativePath.split(path.sep);
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw containmentError(
      relativePath,
      'empty, current-directory, and traversal components are not allowed'
    );
  }

  return path.normalize(relativePath);
}

export function resolveSourcePath(boundary: CopyBoundary, relativePath: string): string {
  const normalizedPath = validateRelativePath(relativePath);
  const root = boundary.sourceRoot;
  assertPinnedRoot(root, 'source', relativePath);

  const candidatePath = path.resolve(root.canonicalPath, normalizedPath);
  if (!isContained(root.canonicalPath, candidatePath)) {
    throw containmentError(relativePath, 'source path escapes its pinned root');
  }

  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(candidatePath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ELOOP') {
      throw containmentError(relativePath, 'source path contains a symlink cycle', error);
    }
    throw error;
  }

  if (!isContained(root.canonicalPath, canonicalPath)) {
    throw containmentError(relativePath, 'resolved source path escapes its pinned root');
  }
  return canonicalPath;
}

function resolveDestinationPath(boundary: CopyBoundary, relativePath: string): string {
  const normalizedPath = validateRelativePath(relativePath);
  const root = boundary.destinationRoot;
  assertPinnedRoot(root, 'destination', relativePath);

  const candidatePath = path.resolve(root.canonicalPath, normalizedPath);
  if (!isContained(root.canonicalPath, candidatePath)) {
    throw containmentError(relativePath, 'destination path escapes its pinned root');
  }

  let existingPath: string;
  try {
    fs.lstatSync(candidatePath);
    existingPath = candidatePath;
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
    // The copy pipeline creates directories parent-first in phase two, so the
    // immediate parent must exist before any mkdir/copy effect is attempted.
    existingPath = path.dirname(candidatePath);
  }

  let canonicalExistingPath: string;
  try {
    canonicalExistingPath = fs.realpathSync.native(existingPath);
  } catch (error: unknown) {
    throw containmentError(relativePath, 'destination contains an unresolved symlink', error);
  }

  if (!isContained(root.canonicalPath, canonicalExistingPath)) {
    throw containmentError(relativePath, 'resolved destination path escapes its pinned root');
  }

  const unresolvedSuffix = path.relative(existingPath, candidatePath);
  const resolvedPath = unresolvedSuffix
    ? path.join(canonicalExistingPath, unresolvedSuffix)
    : canonicalExistingPath;
  if (!isContained(root.canonicalPath, resolvedPath)) {
    throw containmentError(relativePath, 'resolved destination path escapes its pinned root');
  }
  return resolvedPath;
}

export function createCopyBoundary(
  sourceBase: string,
  destinationBase: string,
  expectedBoundary?: CopyBoundary
): CopyBoundary {
  return {
    sourceRoot: pinRoot(sourceBase, 'source', expectedBoundary?.sourceRoot),
    destinationRoot: pinRoot(destinationBase, 'destination', expectedBoundary?.destinationRoot),
  };
}

export function resolveCopyPath(
  boundary: CopyBoundary,
  relativePath: string
): { sourcePath: string; destinationPath: string } {
  return {
    sourcePath: resolveSourcePath(boundary, relativePath),
    destinationPath: resolveDestinationPath(boundary, relativePath),
  };
}

export function isCopyContainmentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === CONTAINMENT_ERROR_CODE
  );
}

interface CopyErrorPayload {
  code?: string | null;
  relativePath?: unknown;
  name?: string;
  message: string;
}

export function copyErrorFromPayload(payload: CopyErrorPayload): Error {
  const error =
    payload.code === CONTAINMENT_ERROR_CODE
      ? new CopyContainmentError(payload.relativePath, 'worker rejected an unsafe path')
      : new Error(payload.message);
  error.name = payload.name || error.name;
  error.message = payload.message;
  if (payload.code && !(error instanceof CopyContainmentError)) {
    Object.assign(error, { code: payload.code });
  }
  return error;
}
