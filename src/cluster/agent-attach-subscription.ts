import { CapabilityNotSupportedError, InvalidResponseError } from './errors.js';
import { isRecord } from './json-guards.js';
import {
  establishEventSubscription,
  type ClusterSubscriptionTransport,
  type CursorlessEventStream,
  type EventOrClosed,
} from './subscription-stream.js';
import type {
  AgentAttachEvent,
  AgentAttachParams,
  AgentAttachResult,
  ServerCapabilities,
} from './wire-types.generated.js';

export type AgentAttachEventOrClosed = EventOrClosed<AgentAttachEvent>;

function extractAgentAttachEvent(params: Record<string, unknown>): AgentAttachEvent {
  const event = params.event;
  if (!isRecord(event)) throw new InvalidResponseError('agent-attach event notification missing event');
  // Trust the wire boundary for the event's variant shape, same as every other generated wire type
  // at this transport layer — see envelope.ts's parseUnaryResponseLine.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return event as unknown as AgentAttachEvent;
}

/**
 * Typed `agent/attach` subscription client. Cursorless, capability-gated, and read-only: scoped to
 * a single `ExecutionRef` rather than being cluster-wide, with no run scoping and no replay. Mirrors
 * crates/openengine-cluster-client/src/ndjson_agent_attach.rs.
 */
export class AgentAttachSubscriptionClient {
  private readonly transport: ClusterSubscriptionTransport;

  constructor(transport: ClusterSubscriptionTransport) {
    this.transport = transport;
  }

  /**
   * @param capabilities The server's advertised capabilities, from a prior `initialize()` call.
   *   Throws {@link CapabilityNotSupportedError} before opening any connection if
   *   `capabilities.agentAttach` is falsy.
   */
  agentAttach(
    params: AgentAttachParams,
    capabilities: ServerCapabilities
  ): Promise<{ result: AgentAttachResult; stream: CursorlessEventStream<AgentAttachEvent> }> {
    if (!capabilities.agentAttach) throw new CapabilityNotSupportedError('agentAttach');
    return establishEventSubscription<AgentAttachParams, AgentAttachResult, AgentAttachEvent>(
      this.transport,
      'agent/attach',
      params,
      extractAgentAttachEvent
    );
  }
}
