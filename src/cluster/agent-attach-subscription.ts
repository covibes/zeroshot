/**
 * Typed `agent/attach` subscription client: cursorless, no dedup, no reconnect. Mirrors the
 * `agent_attach` instantiation of `impl_ndjson_event_subscription!` in
 * crates/openengine-cluster-client/src/ndjson_agent_attach.rs. The generated
 * {@link AgentAttachResult} and {@link AgentAttachEvent} types carry no `cursor`/`runId` field, so
 * none can leak through this client.
 */

import { createEventSubscription, type EventSubscriptionStream } from './event-subscription.js';
import type { AgentAttachEvent, AgentAttachParams, AgentAttachResult } from './generated/wire-types.js';
import type { SubscriptionTransport } from './transport.js';

export type AgentAttachEventStream = EventSubscriptionStream<AgentAttachEvent>;

export function agentAttach(
  transport: SubscriptionTransport,
  params: AgentAttachParams
): Promise<{ result: AgentAttachResult; stream: AgentAttachEventStream }> {
  return createEventSubscription<'agent/attach', AgentAttachParams, AgentAttachResult, AgentAttachEvent>(
    transport,
    'agent/attach',
    params,
    'event'
  );
}
