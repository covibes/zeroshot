import { CapabilityNotSupportedError, InvalidResponseError } from './errors.js';
import { isRecord } from './json-guards.js';
import {
  establishEventSubscription,
  type ClusterSubscriptionTransport,
  type CursorlessEventStream,
  type EventOrClosed,
} from './subscription-stream.js';
import type { LogRecord, LogsParams, LogsResult, ServerCapabilities } from './wire-types.generated.js';

export type LogEventOrClosed = EventOrClosed<LogRecord>;

function extractLogRecord(params: Record<string, unknown>): LogRecord {
  const record = params.record;
  if (!isRecord(record)) throw new InvalidResponseError('log event notification missing record');
  // Trust the wire boundary for the record's field shape (level/target/message), same as every
  // other generated wire type at this transport layer — see envelope.ts's parseUnaryResponseLine.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return record as unknown as LogRecord;
}

/**
 * Typed `logs` subscription client. Cursorless and capability-gated: `logs` has no run scoping and
 * no replay, unlike `watch`. Mirrors
 * crates/openengine-cluster-client/src/ndjson_logs.rs (generated there from the shared
 * `impl_ndjson_event_subscription!` macro; here from {@link establishEventSubscription}).
 */
export class LogsSubscriptionClient {
  private readonly transport: ClusterSubscriptionTransport;

  constructor(transport: ClusterSubscriptionTransport) {
    this.transport = transport;
  }

  /**
   * @param capabilities The server's advertised capabilities, from a prior `initialize()` call.
   *   Throws {@link CapabilityNotSupportedError} before opening any connection if `capabilities.logs`
   *   is falsy.
   */
  logs(
    params: LogsParams,
    capabilities: ServerCapabilities
  ): Promise<{ result: LogsResult; stream: CursorlessEventStream<LogRecord> }> {
    if (!capabilities.logs) throw new CapabilityNotSupportedError('logs');
    return establishEventSubscription<LogsParams, LogsResult, LogRecord>(
      this.transport,
      'logs',
      params,
      extractLogRecord
    );
  }
}
