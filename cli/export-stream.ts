import crypto = require('crypto');
import fs = require('fs');

export interface ExportStream {
  readonly fd?: number;
  write(value: string): unknown;
}

export interface Destination {
  close(): void;
  write(value: string): void;
}

export interface RecordWriter {
  readonly records: number;
  finish(record: Record<string, unknown>): void;
  write(record: Record<string, unknown>): void;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function sameFileSnapshot(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function writeAll(fd: number, value: string, label: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`${label} export destination stopped accepting bytes`);
    }
    offset += written;
  }
}

function streamDestination(stdout: ExportStream, label: string): Destination {
  if (typeof stdout.fd === 'number' && Number.isInteger(stdout.fd)) {
    const fd = stdout.fd;
    return { close(): void {}, write: (value) => writeAll(fd, value, label) };
  }
  return {
    close(): void {},
    write(value): void {
      stdout.write(value);
    },
  };
}

export function createExclusiveDestination(
  outputPath: string | null | undefined,
  stdout: ExportStream,
  label: string
): Destination {
  if (!outputPath) return streamDestination(stdout, label);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(outputPath, flags, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return { close: () => fs.closeSync(fd), write: (value) => writeAll(fd, value, label) };
}

export function createReplacingDestination(
  outputPath: string | null | undefined,
  stdout: ExportStream
): Destination {
  if (!outputPath) return streamDestination(stdout, 'JSON');
  const fd = fs.openSync(outputPath, 'w');
  return { close: () => fs.closeSync(fd), write: (value) => writeAll(fd, value, 'JSON') };
}

export function createRecordWriter(destination: Destination): RecordWriter {
  const digest = crypto.createHash('sha256');
  let records = 0;
  const encode = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
  return {
    get records(): number {
      return records;
    },
    write(record): void {
      const line = encode(record);
      digest.update(line);
      destination.write(line);
      records += 1;
    },
    finish(record): void {
      destination.write(
        encode({ ...record, preceding_records: records, records_sha256: digest.digest('hex') })
      );
    },
  };
}
