import {isAgentAttachClosedParams, isAgentAttachEventNotificationParams} from '../json-guards.js';
import type {AgentAttachEvent} from '../generated/wire-types.js';
import type {ConnectionMultiplexer, SubscriptionDelivery} from '../transport/multiplexer.js';
import {SubscriptionStream} from './subscription-stream.js';

/**
 * An `agent/attach` subscription: a live stream of {@link AgentAttachEvent}s for one execution.
 * Deliberately carries no cursor or `reconnect` member at all -- `agent/attach` gives a
 * type-level "cursorless" guarantee, matching the Rust `agent_attach.rs` "no replay" contract.
 */
export class AgentAttachSubscriptionStream extends SubscriptionStream<AgentAttachEvent> {
  public constructor(
    subscriptionId: string,
    transport: ConnectionMultiplexer,
    deliveries: AsyncIterable<SubscriptionDelivery>
  ) {
    super(subscriptionId, transport, deliveries);
  }

  protected override parseEvent(params: unknown): AgentAttachEvent | null {
    return isAgentAttachEventNotificationParams(params) ? params.event : null;
  }

  protected override parseClosedReason(params: unknown): string | null {
    return isAgentAttachClosedParams(params) ? params.reason : null;
  }
}
