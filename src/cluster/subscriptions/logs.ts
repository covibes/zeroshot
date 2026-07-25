import {isLogEventNotificationParams, isLogsClosedParams} from '../json-guards.js';
import type {LogRecord} from '../generated/wire-types.js';
import type {ConnectionMultiplexer, SubscriptionDelivery} from '../transport/multiplexer.js';
import {SubscriptionStream} from './subscription-stream.js';

/**
 * A `logs` subscription: a live stream of {@link LogRecord}s. Deliberately carries no cursor or
 * `reconnect` member at all -- `logs` gives a type-level "cursorless" guarantee, matching the Rust
 * `logs.rs` "no replay" contract. A dropped connection means resubscribing via
 * {@link import('../connect.js').connectCluster}'s `logs()` factory, not resuming this stream.
 */
export class LogsSubscriptionStream extends SubscriptionStream<LogRecord> {
  public constructor(
    subscriptionId: string,
    transport: ConnectionMultiplexer,
    deliveries: AsyncIterable<SubscriptionDelivery>
  ) {
    super(subscriptionId, transport, deliveries);
  }

  protected override parseEvent(params: unknown): LogRecord | null {
    return isLogEventNotificationParams(params) ? params.record : null;
  }

  protected override parseClosedReason(params: unknown): string | null {
    return isLogsClosedParams(params) ? params.reason : null;
  }
}
