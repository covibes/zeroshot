import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import { nullableString, sameFileSnapshot } from './export-stream';
import type { OpenedEvidence, SemanticTask } from './semantic-contract';
import { expectedLogPath } from './trace-evidence';
import { TRACE_OUTPUT_CHUNK_BYTES } from './trace-output';

function hashOpenedEvidence(fd: number, byteLength: number): { bytes: number; sha256: string } {
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  while (bytes < byteLength) {
    const buffer = Buffer.allocUnsafe(Math.min(TRACE_OUTPUT_CHUNK_BYTES, byteLength - bytes));
    const read = fs.readSync(fd, buffer, 0, buffer.length, bytes);
    if (read === 0) break;
    digest.update(read === buffer.length ? buffer : buffer.subarray(0, read));
    bytes += read;
  }
  return { bytes, sha256: digest.digest('hex') };
}

function unavailable(issue: string): OpenedEvidence {
  return { fd: null, before: null, byteLength: null, sha256: null, issue };
}

export function openEvidence(
  taskId: string,
  task: SemanticTask,
  allowedLogRoot: string
): OpenedEvidence {
  const expected = expectedLogPath(allowedLogRoot, taskId);
  const recorded = nullableString(task.logFile);
  if (!expected || !recorded || path.resolve(recorded) !== expected) {
    return unavailable('log_reference_invalid');
  }
  let fd: number;
  try {
    fd = fs.openSync(expected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    return unavailable(code === 'ENOENT' ? 'log_missing' : 'log_unreadable');
  }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fs.closeSync(fd);
      return unavailable('log_not_regular');
    }
    const byteLength = Number(before.size);
    const hashed = hashOpenedEvidence(fd, byteLength);
    const afterHash = fs.fstatSync(fd, { bigint: true });
    if (hashed.bytes !== byteLength || !sameFileSnapshot(before, afterHash)) {
      fs.closeSync(fd);
      return { ...unavailable('log_changed_during_hash'), byteLength };
    }
    return { fd, before, byteLength, sha256: hashed.sha256, issue: null };
  } catch {
    fs.closeSync(fd);
    return unavailable('log_read_failed');
  }
}

export function emptyEvidence(): OpenedEvidence {
  return { fd: null, before: null, byteLength: null, sha256: null, issue: null };
}
