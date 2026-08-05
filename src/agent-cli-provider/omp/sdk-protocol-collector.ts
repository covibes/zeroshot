import { TextDecoder } from 'node:util';

import { decodeOmpSdkProtocolFrame } from './sdk-protocol-frame';
import { parseOmpSdkSidecarRequest } from './sdk-protocol-request';
import { normalizeOmpSdkResultFrame } from './sdk-protocol-result';
import {
  OMP_SDK_MAX_FRAME_BYTES,
  OMP_SDK_MAX_STDOUT_BYTES,
  type OmpSdkCollectedTerminal,
  type OmpSdkProtocolCollector,
  type OmpSdkProtocolCollectorOptions,
  type OmpSdkProtocolProgressFrame,
  type OmpSdkSidecarRequest,
  type OmpSdkProtocolFrame,
} from './sdk-protocol-types';
import { protocolFailure } from './sdk-protocol-value';

class Collector implements OmpSdkProtocolCollector {
  readonly #request: OmpSdkSidecarRequest;
  readonly #maxFrame: number;
  readonly #maxStdout: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #progress: OmpSdkProtocolProgressFrame[] = [];
  #pending = '';
  #bytes = 0;
  #terminal: OmpSdkCollectedTerminal | undefined;
  #closed = false;
  #failed = false;

  constructor(options: OmpSdkProtocolCollectorOptions) {
    this.#request = parseOmpSdkSidecarRequest(options.request);
    this.#maxFrame = limit(options.maxFrameBytes, OMP_SDK_MAX_FRAME_BYTES, 'maxFrameBytes');
    this.#maxStdout = limit(options.maxStdoutBytes, OMP_SDK_MAX_STDOUT_BYTES, 'maxStdoutBytes');
  }
  get progress(): readonly OmpSdkProtocolProgressFrame[] {
    return this.#progress;
  }
  write(chunk: string | Uint8Array): readonly OmpSdkProtocolFrame[] {
    this.#writable();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (this.#terminal !== undefined && bytes.byteLength > 0) {
      return this.#fail('data follows terminal frame.');
    }
    this.#bytes += bytes.byteLength;
    if (this.#bytes > this.#maxStdout) return this.#fail('stdout is oversized.');
    try {
      this.#pending += this.#decoder.decode(bytes, { stream: true });
    } catch {
      return this.#fail('stdout is not valid UTF-8.');
    }
    try {
      return this.#drain(false);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }
  finish(exitCode: number): OmpSdkCollectedTerminal {
    this.#writable();
    if (!Number.isInteger(exitCode) || exitCode < 0)
      return this.#fail('invalid sidecar exit code.');
    try {
      this.#pending += this.#decoder.decode();
    } catch {
      return this.#fail('stdout is not valid UTF-8.');
    }
    try {
      this.#drain(true);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    if (this.#terminal === undefined) return this.#fail('missing terminal frame.');
    if (this.#terminal.type === 'result' && exitCode !== 0)
      return this.#fail('result requires exit zero.');
    if (this.#terminal.type === 'error' && exitCode === 0)
      return this.#fail('error requires nonzero exit.');
    this.#closed = true;
    return this.#terminal;
  }
  #writable(): void {
    if (this.#failed) protocolFailure('collector is failed.');
    if (this.#closed) protocolFailure('collector is finished.');
  }
  #drain(final: boolean): readonly OmpSdkProtocolFrame[] {
    const frames: OmpSdkProtocolFrame[] = [];
    let newline = this.#pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      frames.push(this.#accept(line));
      newline = this.#pending.indexOf('\n');
    }
    if (final && this.#pending.length > 0) {
      const line = this.#pending;
      this.#pending = '';
      frames.push(this.#accept(line));
    } else if (Buffer.byteLength(this.#pending) > this.#maxFrame) {
      return this.#fail('frame is oversized.');
    }
    return frames;
  }
  #accept(line: string): OmpSdkProtocolFrame {
    if (this.#terminal !== undefined) return this.#fail('data follows terminal frame.');
    const bytes = Buffer.byteLength(line);
    if (bytes === 0 || bytes > this.#maxFrame) return this.#fail('frame has invalid byte length.');
    const frame = decodeOmpSdkProtocolFrame(line);
    if (frame.runId !== this.#request.runId)
      return this.#fail('frame.runId does not match request.');
    if (frame.type === 'progress') {
      if (frame.sequence !== this.#progress.length) return this.#fail('invalid progress sequence.');
      this.#progress.push(frame);
    } else if (frame.type === 'result') {
      this.#terminal = {
        type: 'result',
        frame,
        event: normalizeOmpSdkResultFrame(frame, this.#request),
      };
    } else {
      this.#terminal = { type: 'error', frame };
    }
    return frame;
  }
  #fail(message: string): never {
    this.#failed = true;
    return protocolFailure(message);
  }
}
function limit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    protocolFailure(`${field} must be a positive integer no greater than ${fallback}.`);
  }
  return value;
}
export function createOmpSdkProtocolCollector(
  options: OmpSdkProtocolCollectorOptions
): OmpSdkProtocolCollector {
  return new Collector(options);
}
