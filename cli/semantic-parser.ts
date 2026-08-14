import crypto = require('crypto');
import fs = require('fs');
import type { ProviderAdapter } from './agent-provider-boundary';
import { sameFileSnapshot } from './export-stream';
import { reportDiagnostic, type OpenedEvidence, type TaskProjection } from './semantic-contract';
import { emitEvent, emittedEvents } from './semantic-events';
import { BoundedLineScanner } from './semantic-line-scanner';
import { handleProviderLine } from './semantic-provider-line';
import { TRACE_OUTPUT_CHUNK_BYTES } from './trace-output';

function readEvidence(
  fd: number,
  byteLength: number,
  scanner: BoundedLineScanner,
  digest: crypto.Hash
): number {
  let bytes = 0;
  while (bytes < byteLength) {
    const remaining = byteLength - bytes;
    const buffer = Buffer.allocUnsafe(Math.min(TRACE_OUTPUT_CHUNK_BYTES, remaining));
    const read = fs.readSync(fd, buffer, 0, buffer.length, bytes);
    if (read === 0) break;
    const chunk = read === buffer.length ? buffer : buffer.subarray(0, read);
    digest.update(chunk);
    scanner.consume(chunk, bytes);
    bytes += read;
  }
  scanner.finish(bytes);
  return bytes;
}

function finishAdapter(adapter: ProviderAdapter, state: object, context: TaskProjection): void {
  try {
    const final = adapter.finishParsing?.(state) ?? null;
    for (const event of emittedEvents(final)) emitEvent(context, event, null, 'finish');
  } catch {
    reportDiagnostic(context, 'parser_finish_error', null);
  }
}

function reportProjectionCompleteness(context: TaskProjection): void {
  if (context.provider !== 'pi' && context.logFormat === null) {
    if (!context.issueCodes.has('legacy_ambiguous_channels')) {
      reportDiagnostic(context, 'legacy_ambiguous_channels', null);
    }
  }
  if (!context.terminalResultEmitted) reportDiagnostic(context, 'terminal_result_missing', null);
}

interface StableEvidence {
  fd: number;
  before: fs.BigIntStats;
  byteLength: number;
  sha256: string | null;
}

function sourceMatches(evidence: StableEvidence, bytes: number, digest: crypto.Hash): boolean {
  const after = fs.fstatSync(evidence.fd, { bigint: true });
  return (
    bytes === evidence.byteLength &&
    digest.digest('hex') === evidence.sha256 &&
    sameFileSnapshot(evidence.before, after)
  );
}

export function parseOpenedEvidence(
  evidence: OpenedEvidence,
  context: TaskProjection,
  adapter: ProviderAdapter
): boolean {
  if (evidence.fd === null || evidence.before === null || evidence.byteLength === null)
    return false;
  const stableEvidence: StableEvidence = {
    fd: evidence.fd,
    before: evidence.before,
    byteLength: evidence.byteLength,
    sha256: evidence.sha256,
  };
  const state = adapter.createParserState();
  const digest = crypto.createHash('sha256');
  const scanner = new BoundedLineScanner((line, source) =>
    handleProviderLine(context, state, line, source)
  );
  try {
    const bytes = readEvidence(stableEvidence.fd, stableEvidence.byteLength, scanner, digest);
    finishAdapter(adapter, state, context);
    reportProjectionCompleteness(context);
    const complete = sourceMatches(stableEvidence, bytes, digest);
    if (!complete) reportDiagnostic(context, 'log_changed_during_parse', null);
    return complete;
  } catch {
    reportDiagnostic(context, 'log_read_failed', null);
    return false;
  }
}
