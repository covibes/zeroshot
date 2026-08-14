import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import { isRecord, nullableString, type RecordWriter, sameFileSnapshot } from './export-stream';
import { expectedLogPath, type TraceTask } from './trace-evidence';
import { writeUnavailableOutput } from './trace-output-record';

export const TRACE_OUTPUT_CHUNK_BYTES = 48 * 1024;

interface OutputCapture {
  bytes: number;
}

interface CapturedTaskOutput extends OutputCapture {
  available: boolean;
  complete: boolean;
  chunks: number;
  sha256: string | null;
}

interface StreamTaskOutputOptions {
  writer: RecordWriter;
  taskId: string;
  task: TraceTask;
  allowedLogRoot: string;
  rawOutputRef: string;
  taskTerminal: boolean;
  issues: string[];
}

function openTaskLog(expected: string, taskId: string, issues: string[]): number | null {
  try {
    return fs.openSync(expected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    issues.push(`task:${taskId}:${issueForOpenFailure(error)}`);
    return null;
  }
}

function captureOpenedTaskLog(
  fd: number,
  options: Pick<StreamTaskOutputOptions, 'writer' | 'taskId' | 'rawOutputRef' | 'issues'>
): CapturedTaskOutput {
  const { writer, taskId, rawOutputRef, issues } = options;
  let bytes = 0;
  let chunks = 0;
  const digest = crypto.createHash('sha256');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      issues.push(`task:${taskId}:log_not_regular`);
      return { available: false, complete: false, bytes, chunks, sha256: null };
    }
    const targetBytes = Number(before.size);
    while (bytes < targetBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(TRACE_OUTPUT_CHUNK_BYTES, targetBytes - bytes));
      const read = fs.readSync(fd, buffer, 0, buffer.length, bytes);
      if (read === 0) break;
      const chunk = read === buffer.length ? buffer : buffer.subarray(0, read);
      digest.update(chunk);
      writer.write({
        record_type: 'task_output_chunk',
        task_id: taskId,
        raw_output_ref: rawOutputRef,
        chunk_index: chunks,
        encoding: 'base64',
        data_base64: chunk.toString('base64'),
      });
      bytes += read;
      chunks += 1;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const complete = bytes === targetBytes && sameFileSnapshot(before, after);
    if (!complete) issues.push(`task:${taskId}:log_changed_during_export`);
    return { available: true, complete, bytes, chunks, sha256: digest.digest('hex') };
  } catch {
    issues.push(`task:${taskId}:log_read_failed`);
    return { available: true, complete: false, bytes, chunks, sha256: digest.digest('hex') };
  }
}

export function streamTaskOutput(options: StreamTaskOutputOptions): OutputCapture {
  const { writer, taskId, task, allowedLogRoot, rawOutputRef, taskTerminal, issues } = options;
  const expected = expectedLogPath(allowedLogRoot, taskId);
  const recorded = nullableString(task.logFile);
  if (!expected || !recorded || path.resolve(recorded) !== expected) {
    issues.push(`task:${taskId}:log_reference_invalid`);
    writeUnavailableOutput(writer, taskId, rawOutputRef);
    return { bytes: 0 };
  }
  const fd = openTaskLog(expected, taskId, issues);
  if (fd === null) {
    writeUnavailableOutput(writer, taskId, rawOutputRef);
    return { bytes: 0 };
  }
  let captured: CapturedTaskOutput;
  try {
    captured = captureOpenedTaskLog(fd, { writer, taskId, rawOutputRef, issues });
  } finally {
    fs.closeSync(fd);
  }
  writer.write({
    record_type: 'task_output_end',
    task_id: taskId,
    raw_output_ref: rawOutputRef,
    available: captured.available,
    complete: captured.complete && taskTerminal,
    byte_length: captured.available ? captured.bytes : null,
    chunks: captured.chunks,
    sha256: captured.sha256,
  });
  return { bytes: captured.bytes };
}

function issueForOpenFailure(error: unknown): 'log_missing' | 'log_unreadable' {
  return isRecord(error) && error.code === 'ENOENT' ? 'log_missing' : 'log_unreadable';
}

export { writeUnavailableOutput };
