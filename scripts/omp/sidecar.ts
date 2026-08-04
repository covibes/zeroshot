#!/usr/bin/env bun

import { closeSync, promises as fs } from 'node:fs';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  OMP_SDK_MAX_REQUEST_BYTES,
  parseOmpSdkProtocolFrame,
  type OmpSdkErrorCategory,
  type OmpSdkErrorCode,
  type OmpSdkProtocolFrame,
} from '../../src/agent-cli-provider/omp/sdk-protocol';
import {
  executeOmpSdkSidecar,
  serializeOmpSdkFrame,
} from '../../src/agent-cli-provider/omp/sdk-sidecar';

function safeError(
  runId: string,
  code: OmpSdkErrorCode,
  category: OmpSdkErrorCategory
): OmpSdkProtocolFrame {
  return parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'error',
    runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    error: { code, category, retryable: false, redacted: true },
  });
}

function runIdFrom(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const runId = (value as Record<string, unknown>).runId;
  return typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId) && Buffer.byteLength(runId) <= 128
    ? runId
    : 'unknown';
}

async function assertPrivateRequest(requestPath: string): Promise<void> {
  const stat = await fs.stat(requestPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > OMP_SDK_MAX_REQUEST_BYTES || (stat.mode & 0o077) !== 0) {
    throw new Error('invalid private request file');
  }
}

const originalConsole = {
  debug: console.debug,
  error: console.error,
  info: console.info,
  log: console.log,
  warn: console.warn,
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (() => true) as typeof process.stdout.write;
process.stderr.write = (() => true) as typeof process.stderr.write;
console.debug = () => undefined;
console.error = () => undefined;
console.info = () => undefined;
console.log = () => undefined;
console.warn = () => undefined;

const abortController = new AbortController();
const abort = (): void => abortController.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

let frame: OmpSdkProtocolFrame;
let requestPath: string | undefined;
let request: unknown;
let removeRequest = false;
try {
  if (process.argv.length !== 3) throw new Error('one request path is required');
  requestPath = process.argv[2];
  if (requestPath === undefined) throw new Error('request path is required');
  await assertPrivateRequest(requestPath);
  removeRequest = true;
  request = JSON.parse(await fs.readFile(requestPath, 'utf8')) as unknown;
  frame = await executeOmpSdkSidecar(request, { signal: abortController.signal });
} catch {
  try {
    closeSync(3);
  } catch {
    // The credential channel may already have been consumed and closed.
  }
  frame = safeError(runIdFrom(request), 'invalid-request', 'request');
}

if (requestPath !== undefined && removeRequest) {
  try {
    await fs.unlink(requestPath);
  } catch {
    frame = safeError(runIdFrom(request), 'cleanup-error', 'cleanup');
  }
}
process.removeListener('SIGINT', abort);
process.removeListener('SIGTERM', abort);
if (abortController.signal.aborted) {
  frame = safeError(runIdFrom(request), 'cancelled', 'cancelled');
}

console.debug = originalConsole.debug;
console.error = originalConsole.error;
console.info = originalConsole.info;
console.log = originalConsole.log;
console.warn = originalConsole.warn;
process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
process.stderr.write = originalStderrWrite as typeof process.stderr.write;
originalStdoutWrite(serializeOmpSdkFrame(frame));
process.exitCode = frame.type === 'result' ? 0 : 1;
