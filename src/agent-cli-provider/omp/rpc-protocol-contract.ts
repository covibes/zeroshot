import { OMP_SUPPORTED_VERSION } from './release';

export const OMP_RPC_CONTRACT_RELEASE = OMP_SUPPORTED_VERSION;

export interface OmpRpcDecoderLimits {
  readonly maxPhysicalFrameBytes: number;
  readonly maxReassembledFrameBytes: number;
  readonly maxConcurrentReassemblies: number;
  readonly maxChunksPerFrame: number;
  readonly maxInflightReassemblyBytes: number;
}

export const DEFAULT_OMP_RPC_DECODER_LIMITS: OmpRpcDecoderLimits = {
  maxPhysicalFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
  maxConcurrentReassemblies: 1,
  maxChunksPerFrame: 256,
  maxInflightReassemblyBytes: 64 * 1024 * 1024,
};

export interface OmpRpcInboundFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface OmpRpcCommand {
  readonly id?: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export class OmpRpcProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OmpRpcProtocolError';
    this.code = code;
  }
}

const KNOWN_PRE_NEGOTIATION_FRAME_TYPES: Readonly<Record<string, true>> = Object.freeze(Object.fromEntries([
  'ready', 'available_commands_update', 'response', 'extension_error', 'agent_start', 'agent_end',
  'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start',
  'tool_execution_update', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end',
  'auto_retry_start', 'auto_retry_end', 'ttsr_triggered', 'todo_reminder', 'todo_auto_clear',
  'extension_ui_request', 'host_tool_call', 'host_tool_cancel', 'host_uri_request', 'host_uri_cancel',
  'prompt_result', 'command_output', 'session_info_update', 'config_update', 'subagent_lifecycle',
  'subagent_progress', 'subagent_event',
].map((type) => [type, true] as const)));

export function classifyOmpRpcFrameType(type: string): 'known-pre-negotiation' | 'v2-only' | 'unknown' {
  if (type === 'rpc_chunk') return 'v2-only';
  if (KNOWN_PRE_NEGOTIATION_FRAME_TYPES[type] === true) return 'known-pre-negotiation';
  return 'unknown';
}

export function assertNoPreNegotiationRpcChunk(frameType: string, negotiatedV2: boolean): void {
  if (frameType === 'rpc_chunk' && !negotiatedV2) {
    throw new OmpRpcProtocolError(
      'pre-negotiation-rpc-chunk',
      'rpc_chunk frame received before protocol v2 negotiation succeeded.'
    );
  }
}

export function encodeOmpRpcCommand(command: OmpRpcCommand, maxFrameBytes: number): Buffer {
  const line = `${JSON.stringify(command)}\n`;
  const byteLength = Buffer.byteLength(line, 'utf8');
  if (byteLength > maxFrameBytes) {
    throw new OmpRpcProtocolError(
      'outbound-frame-too-large',
      `Outbound command of ${byteLength} bytes exceeds the ${maxFrameBytes}-byte limit.`
    );
  }
  return Buffer.from(line, 'utf8');
}
