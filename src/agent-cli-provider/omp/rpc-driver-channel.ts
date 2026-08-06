import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { MAX_LIFETIME_REQUEST_IDS, MAX_PENDING_REQUESTS } from './rpc-bounds';
import {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  encodeOmpRpcCommand,
  type OmpRpcCommand,
  type OmpRpcInboundFrame,
} from './rpc-protocol';
import { getBoolean, getOptionalString, getString } from '../json';
import { OmpRpcTaskFailure, UI_RESPONDERS, type DriverState } from './rpc-driver-state';

export class OmpRpcChannel {
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly state: DriverState
  ) {}

  registerLifetimeId(id: string): boolean {
    if (this.state.lifetimeRequestIds.has(id)) return true;
    if (this.state.lifetimeRequestIds.size >= MAX_LIFETIME_REQUEST_IDS) return false;
    this.state.lifetimeRequestIds.add(id);
    return true;
  }

  writeFrame(frame: OmpRpcCommand): void {
    if (this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(
        encodeOmpRpcCommand(frame, DEFAULT_OMP_RPC_DECODER_LIMITS.maxPhysicalFrameBytes)
      );
    } catch {
      // Stdin already closed; the close handler settles the task.
    }
  }

  sendCommand(command: OmpRpcCommand): Promise<Record<string, unknown>> {
    const id = command.id ?? '';
    if (!this.registerLifetimeId(id)) {
      return Promise.reject(
        new OmpRpcTaskFailure(
          'lifetime-request-id-exceeded',
          `command id "${id}" exceeds the lifetime request-id bound.`
        )
      );
    }
    if (this.state.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new OmpRpcTaskFailure(
          'pending-request-exceeded',
          'too many concurrent outbound RPC commands are awaiting a response.'
        )
      );
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.state.pending.set(id, { resolve, reject });
      this.writeFrame(command);
    });
  }

  assertSuccessfulResponse(response: Record<string, unknown>, command: string, id: string): void {
    if (getString(response, 'command') !== command || getString(response, 'id') !== id) {
      throw new OmpRpcTaskFailure(
        'malformed-response',
        `Expected a ${command} response with id "${id}".`
      );
    }
    if (getBoolean(response, 'success') !== true) {
      throw new OmpRpcTaskFailure(
        'unsafe-config',
        getString(response, 'error') ?? `${command} was rejected.`
      );
    }
  }

  handleResponse(frame: OmpRpcInboundFrame): void {
    const id = getOptionalString(frame, 'id');
    if (!id) return;
    const command = this.state.pending.get(id);
    if (command === undefined) return;
    this.state.pending.delete(id);
    command.resolve(frame);
  }

  handleExtensionUiRequest(frame: OmpRpcInboundFrame): void {
    const id = getString(frame, 'id');
    const method = getString(frame, 'method');
    if (id === null || method === null) {
      throw new OmpRpcTaskFailure(
        'malformed-extension-ui-request',
        'extension_ui_request is missing id/method.'
      );
    }
    this.assertInboundId(id);
    const responder = UI_RESPONDERS[method];
    if (responder === undefined) {
      throw new OmpRpcTaskFailure(
        'unsupported-ui-method',
        `extension_ui_request used unsupported method "${method}".`
      );
    }
    this.writeFrame(responder(id));
  }

  handleHostToolCall(frame: OmpRpcInboundFrame): void {
    const id = this.inboundId(frame, 'malformed-host-tool-call', 'host_tool_call is missing id.');
    this.writeFrame({
      type: 'host_tool_result',
      id,
      isError: true,
      result: { content: [{ type: 'text', text: 'Zeroshot declares no host tools' }] },
    });
  }

  handleHostUriRequest(frame: OmpRpcInboundFrame): void {
    const id = this.inboundId(
      frame,
      'malformed-host-uri-request',
      'host_uri_request is missing id.'
    );
    this.writeFrame({
      type: 'host_uri_result',
      id,
      isError: true,
      error: 'Zeroshot declares no host URI schemes',
    });
  }

  private inboundId(frame: OmpRpcInboundFrame, code: string, message: string): string {
    const id = getString(frame, 'id');
    if (id === null) throw new OmpRpcTaskFailure(code, message);
    this.assertInboundId(id);
    return id;
  }

  private assertInboundId(id: string): void {
    if (!this.registerLifetimeId(id)) {
      throw new OmpRpcTaskFailure(
        'lifetime-request-id-exceeded',
        `inbound request id "${id}" exceeds the lifetime request-id bound.`
      );
    }
  }
}
