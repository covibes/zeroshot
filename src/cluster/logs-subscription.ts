/**
 * Typed `logs` subscription client: cursorless, no dedup, no reconnect. Mirrors the `logs`
 * instantiation of `impl_ndjson_event_subscription!` in
 * crates/openengine-cluster-client/src/ndjson_logs.rs. The generated {@link LogsResult} and
 * {@link LogRecord} types carry no `cursor`/`runId` field, so none can leak through this client.
 */

import { createEventSubscription, type EventSubscriptionStream } from './event-subscription.js';
import type { LogRecord, LogsParams, LogsResult } from './generated/wire-types.js';
import type { SubscriptionTransport } from './transport.js';

export type LogEventStream = EventSubscriptionStream<LogRecord>;

export function logs(
  transport: SubscriptionTransport,
  params: LogsParams = {}
): Promise<{ result: LogsResult; stream: LogEventStream }> {
  return createEventSubscription<'logs', LogsParams, LogsResult, LogRecord>(
    transport,
    'logs',
    params,
    'record'
  );
}
