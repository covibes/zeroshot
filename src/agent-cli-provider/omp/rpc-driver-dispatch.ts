import { MAX_PENDING_REQUESTS } from './rpc-bounds';
import {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  OmpRpcProtocolError,
  assertNoPreNegotiationRpcChunk,
  type OmpRpcInboundFrame,
} from './rpc-protocol';
import { normalizeOmpRpcFrame } from './rpc-events';
import { getArray, getBoolean, getNumber, getRecord, getString } from '../json';
import type { OmpRpcChannel } from './rpc-driver-channel';
import {
  OmpRpcTaskFailure,
  sessionEvidenceFromState,
  sessionFieldsFromRecord,
  type DriverState,
  type OmpRpcTaskHooks,
  type OmpRpcTaskRequest,
} from './rpc-driver-state';
import type { OutputEvent } from '../types';

interface DispatchContext {
  readonly request: OmpRpcTaskRequest;
  readonly hooks: OmpRpcTaskHooks;
  readonly state: DriverState;
  readonly channel: OmpRpcChannel;
  readonly spawnHook: Promise<void>;
  readonly pushEvent: (event: OutputEvent) => void;
  readonly fail: (stopReason: string, message: string) => void;
  readonly agentEnd: () => void;
}

export class OmpRpcDispatcher {
  constructor(private readonly context: DispatchContext) {}

  enqueue(frame: OmpRpcInboundFrame): void {
    const { state } = this.context;
    if (state.queuedFrames >= MAX_PENDING_REQUESTS) {
      this.context.fail(
        'pending-request-exceeded',
        `More than ${MAX_PENDING_REQUESTS} RPC frames are queued awaiting dispatch.`
      );
      return;
    }
    state.queuedFrames += 1;
    state.chain = state.chain
      .then(() => this.dispatchFrame(frame))
      .catch((error: unknown) => this.failFrom(error))
      .finally(() => {
        state.queuedFrames -= 1;
      });
  }

  private failFrom(error: unknown): void {
    if (error instanceof OmpRpcProtocolError) this.context.fail(error.code, error.message);
    else if (error instanceof OmpRpcTaskFailure) {
      this.context.fail(error.stopReason, error.message);
    } else {
      this.context.fail('driver-error', error instanceof Error ? error.message : String(error));
    }
  }

  private dispatchReadyFrame(frame: OmpRpcInboundFrame): void {
    const { state } = this.context;
    state.readyReceived = true;
    if (frame.type !== 'ready') {
      throw new OmpRpcTaskFailure(
        'unsupported-protocol',
        `Expected an initial ready frame, got "${frame.type}".`
      );
    }
    const supportedVersions = getArray(frame, 'supportedProtocolVersions');
    if (!supportedVersions.includes(2)) {
      throw new OmpRpcTaskFailure(
        'unsupported-protocol',
        `OMP ready frame did not advertise protocol v2 (supportedProtocolVersions=${JSON.stringify(supportedVersions)}).`
      );
    }
    const maxFrameBytes = getNumber(frame, 'maxFrameBytes');
    const maxReassembledFrameBytes = getNumber(frame, 'maxReassembledFrameBytes');
    if (
      maxFrameBytes === null ||
      maxFrameBytes > DEFAULT_OMP_RPC_DECODER_LIMITS.maxPhysicalFrameBytes ||
      maxReassembledFrameBytes === null ||
      maxReassembledFrameBytes > DEFAULT_OMP_RPC_DECODER_LIMITS.maxReassembledFrameBytes
    ) {
      throw new OmpRpcTaskFailure(
        'unsupported-limits',
        `OMP ready frame advertised limits above the pinned decoder caps (maxFrameBytes=${String(maxFrameBytes)}, maxReassembledFrameBytes=${String(maxReassembledFrameBytes)}).`
      );
    }
    void this.negotiateAndPrompt().catch((error: unknown) => this.failFrom(error));
  }

  private async negotiateAndPrompt(): Promise<void> {
    const { state, request, hooks, channel } = this.context;
    await this.context.spawnHook;
    if (state.settled) return;
    const negotiateResponse = await channel.sendCommand({
      id: 'zs-1',
      type: 'negotiate_protocol',
      protocolVersion: 2,
    });
    channel.assertSuccessfulResponse(negotiateResponse, 'negotiate_protocol', 'zs-1');
    state.negotiatedV2 = true;

    const stateResponse = await channel
      .sendCommand({ id: 'zs-state', type: 'get_state' })
      .catch(() => null);
    state.sessionEvidence = sessionEvidenceFromState(stateResponse);
    await hooks.onSession({ ...state.sessionEvidence, phase: 'ready' });

    state.promptSent = true;
    const ack = await channel.sendCommand({ id: 'zs-2', type: 'prompt', message: request.prompt });
    channel.assertSuccessfulResponse(ack, 'prompt', 'zs-2');
    const data = getRecord(ack, 'data');
    if (data !== null && getBoolean(data, 'agentInvoked') === false) {
      throw new OmpRpcTaskFailure(
        'local-only-prompt',
        'OMP resolved the prompt without invoking the agent (no agent turn).'
      );
    }
  }

  private handlePromptResultFrame(frame: OmpRpcInboundFrame): void {
    if (getString(frame, 'id') !== 'zs-2') return;
    if (getBoolean(frame, 'agentInvoked') === true) return;
    throw new OmpRpcTaskFailure(
      'local-only-prompt',
      'OMP resolved the prompt without invoking the agent (no agent turn).'
    );
  }

  private handleSessionInfoUpdate(frame: OmpRpcInboundFrame): Promise<void> | void {
    const updates = sessionFieldsFromRecord(frame);
    if (Object.keys(updates).length === 0) return;
    const { state, hooks } = this.context;
    state.sessionEvidence = { ...state.sessionEvidence, ...updates };
    return hooks.onSession({ ...state.sessionEvidence, phase: 'ready' });
  }

  private dispatchFrame(frame: OmpRpcInboundFrame): void | Promise<void> {
    const { state, channel } = this.context;
    if (state.terminal) return;
    if (!state.readyReceived) return this.dispatchReadyFrame(frame);
    assertNoPreNegotiationRpcChunk(frame.type, state.negotiatedV2);
    switch (frame.type) {
      case 'response':
        return channel.handleResponse(frame);
      case 'extension_ui_request':
        return channel.handleExtensionUiRequest(frame);
      case 'host_tool_call':
        return channel.handleHostToolCall(frame);
      case 'host_uri_request':
        return channel.handleHostUriRequest(frame);
      case 'host_tool_cancel':
      case 'host_uri_cancel':
        return;
      case 'extension_error':
        throw new OmpRpcTaskFailure(
          'extension-error',
          getString(frame, 'error') ?? 'OMP extension runner reported an error.'
        );
      case 'prompt_result':
        return this.handlePromptResultFrame(frame);
      case 'agent_end':
        return this.context.agentEnd();
      case 'session_info_update':
        return this.handleSessionInfoUpdate(frame);
      default:
        if (state.promptSent) {
          for (const event of normalizeOmpRpcFrame(frame, state.eventState)) {
            this.context.pushEvent(event);
          }
        }
    }
  }
}
