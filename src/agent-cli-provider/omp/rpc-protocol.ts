import { getNumber, getString, isRecord } from '../json';
import { OMP_SUPPORTED_VERSION } from './release';

// Purely for traceability/doc; no runtime coupling to omp-release's spawn/install concerns.
export const OMP_RPC_CONTRACT_RELEASE = OMP_SUPPORTED_VERSION;

export interface OmpRpcDecoderLimits {
  readonly maxPhysicalFrameBytes: number;
  readonly maxReassembledFrameBytes: number;
  readonly maxConcurrentReassemblies: number;
  readonly maxChunksPerFrame: number;
  readonly maxInflightReassemblyBytes: number;
}

// Verified against the pinned OMP release's rpc-frame.ts: MAX_RPC_FRAME_BYTES=1MiB, MAX_RPC_REASSEMBLED_BYTES=64MiB,
// RPC_CHUNK_PAYLOAD_BYTES=256KiB -> ceil(64MiB/256KiB)=256 chunks max. The real decoder tracks exactly one
// pending sequence at a time, so maxConcurrentReassemblies/maxInflightReassemblyBytes mirror that ceiling.
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

const KNOWN_PRE_NEGOTIATION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'available_commands_update',
  'response',
  'extension_error',
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'auto_compaction_start',
  'auto_compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'ttsr_triggered',
  'todo_reminder',
  'todo_auto_clear',
  'extension_ui_request',
  'host_tool_call',
  'host_tool_cancel',
  'host_uri_request',
  'host_uri_cancel',
  'prompt_result',
  'command_output',
  'session_info_update',
  'config_update',
  'subagent_lifecycle',
  'subagent_progress',
  'subagent_event',
]);

export function classifyOmpRpcFrameType(
  type: string
): 'known-pre-negotiation' | 'v2-only' | 'unknown' {
  if (type === 'rpc_chunk') return 'v2-only';
  if (KNOWN_PRE_NEGOTIATION_FRAME_TYPES.has(type)) return 'known-pre-negotiation';
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

const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeStrictBase64(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0 || !STRICT_BASE64_PATTERN.test(data)) {
    throw new OmpRpcProtocolError(
      'invalid-chunk-data',
      "rpc_chunk 'data' must be a non-empty, canonically-padded base64 string."
    );
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) {
    throw new OmpRpcProtocolError(
      'invalid-chunk-data',
      "rpc_chunk 'data' failed a base64 round-trip check (non-canonical encoding)."
    );
  }
  return bytes;
}

function decodeStrictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OmpRpcProtocolError(
      'invalid-utf8-in-reassembled-frame',
      'Reassembled rpc_chunk sequence is not valid UTF-8.'
    );
  }
}

function toPhysicalFrame(record: Record<string, unknown>): OmpRpcInboundFrame {
  const type = getString(record, 'type');
  if (type === null) {
    throw new OmpRpcProtocolError(
      'malformed-physical-frame',
      "Physical frame is missing a string 'type' field."
    );
  }
  return { ...record, type };
}

function toReassembledFrame(record: Record<string, unknown>, chunkId: string): OmpRpcInboundFrame {
  const type = getString(record, 'type');
  if (type === null) {
    throw new OmpRpcProtocolError(
      'malformed-json-in-reassembled-frame',
      `rpc_chunk sequence "${chunkId}" reassembled into an object missing a string 'type' field.`
    );
  }
  return { ...record, type };
}

interface ChunkMetadata {
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
}

function readChunkMetadata(
  parsed: Record<string, unknown>,
  limits: OmpRpcDecoderLimits
): ChunkMetadata {
  const chunkId = getString(parsed, 'chunkId');
  if (chunkId === null || chunkId.length === 0 || chunkId.length > 128) {
    throw new OmpRpcProtocolError(
      'invalid-chunk-metadata',
      "rpc_chunk 'chunkId' must be a non-empty string of at most 128 characters."
    );
  }

  const index = getNumber(parsed, 'index');
  const count = getNumber(parsed, 'count');
  const byteLength = getNumber(parsed, 'byteLength');
  if (
    index === null ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    count === null ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > limits.maxChunksPerFrame ||
    index >= count ||
    byteLength === null ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > limits.maxReassembledFrameBytes
  ) {
    throw new OmpRpcProtocolError(
      'invalid-chunk-metadata',
      "rpc_chunk has invalid 'index'/'count'/'byteLength' metadata."
    );
  }

  return { chunkId, index, count, byteLength };
}

interface PendingReassembly {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  nextIndex: number;
  readonly chunks: Buffer[];
  receivedBytes: number;
}

export class OmpRpcFrameDecoder {
  private readonly limits: OmpRpcDecoderLimits;
  private buffer: Buffer;
  private finished: boolean;
  private readonly pendingReassemblies: Map<string, PendingReassembly>;
  private inflightReassemblyBytes: number;

  constructor(limits: OmpRpcDecoderLimits) {
    this.limits = limits;
    this.buffer = Buffer.alloc(0);
    this.finished = false;
    this.pendingReassemblies = new Map();
    this.inflightReassemblyBytes = 0;
  }

  // `negotiatedV2` defaults to true so callers that don't care about pre-negotiation gating
  // (e.g. the fixture-replay tests below) see unchanged behavior; the RPC driver passes its
  // live negotiation state so a bare `rpc_chunk` physical frame is rejected before negotiation
  // succeeds, even though the decoder would otherwise buffer it silently pending reassembly.
  push(chunk: Uint8Array, negotiatedV2 = true): readonly OmpRpcInboundFrame[] {
    if (this.finished) {
      throw new OmpRpcProtocolError('decoder-finished', 'push() called after finish().');
    }

    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: OmpRpcInboundFrame[] = [];

    for (;;) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        if (this.buffer.byteLength > this.limits.maxPhysicalFrameBytes) {
          throw new OmpRpcProtocolError(
            'physical-frame-too-large',
            `Buffered physical frame exceeds the ${this.limits.maxPhysicalFrameBytes}-byte limit without a terminating newline.`
          );
        }
        break;
      }

      const lineBytes = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (lineBytes.byteLength + 1 > this.limits.maxPhysicalFrameBytes) {
        throw new OmpRpcProtocolError(
          'physical-frame-too-large',
          `Physical frame of ${lineBytes.byteLength + 1} bytes exceeds the ${this.limits.maxPhysicalFrameBytes}-byte limit.`
        );
      }

      const frame = this.consumeLine(lineBytes, negotiatedV2);
      if (frame !== null) frames.push(frame);
    }

    return frames;
  }

  finish(): void {
    this.finished = true;
    if (this.buffer.byteLength > 0) {
      throw new OmpRpcProtocolError(
        'incomplete-physical-frame',
        'Stream ended with an unterminated physical frame (no trailing newline).'
      );
    }
    if (this.pendingReassemblies.size > 0) {
      throw new OmpRpcProtocolError(
        'incomplete-chunk-sequence',
        'Stream ended with an incomplete rpc_chunk sequence still pending.'
      );
    }
  }

  private consumeLine(lineBytes: Buffer, negotiatedV2: boolean): OmpRpcInboundFrame | null {
    let value: unknown;
    try {
      value = JSON.parse(lineBytes.toString('utf8'));
    } catch {
      throw new OmpRpcProtocolError('malformed-physical-frame', 'Physical frame is not valid JSON.');
    }
    if (!isRecord(value)) {
      throw new OmpRpcProtocolError(
        'malformed-physical-frame',
        'Physical frame must be a JSON object.'
      );
    }

    const type = getString(value, 'type');
    assertNoPreNegotiationRpcChunk(type ?? '', negotiatedV2);
    if (type !== 'rpc_chunk') {
      if (this.pendingReassemblies.size > 0) {
        throw new OmpRpcProtocolError(
          'interrupted-chunk-sequence',
          'A non-chunk frame arrived while an rpc_chunk sequence was pending.'
        );
      }
      return toPhysicalFrame(value);
    }

    return this.consumeChunk(value);
  }

  private consumeChunk(parsed: Record<string, unknown>): OmpRpcInboundFrame | null {
    const metadata = readChunkMetadata(parsed, this.limits);
    const bytes = decodeStrictBase64(parsed.data);

    let pending = this.pendingReassemblies.get(metadata.chunkId);
    if (pending === undefined) {
      if (metadata.index !== 0) {
        throw new OmpRpcProtocolError(
          'chunk-sequence-must-start-at-zero',
          `rpc_chunk sequence "${metadata.chunkId}" must begin at index 0.`
        );
      }
      if (this.pendingReassemblies.size >= this.limits.maxConcurrentReassemblies) {
        throw new OmpRpcProtocolError(
          'interleaved-chunk-sequence',
          `Starting rpc_chunk sequence "${metadata.chunkId}" would exceed the concurrent-reassembly limit of ${this.limits.maxConcurrentReassemblies}.`
        );
      }
      pending = {
        chunkId: metadata.chunkId,
        count: metadata.count,
        byteLength: metadata.byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
      this.pendingReassemblies.set(metadata.chunkId, pending);
    } else if (
      pending.count !== metadata.count ||
      pending.byteLength !== metadata.byteLength ||
      pending.nextIndex !== metadata.index
    ) {
      throw new OmpRpcProtocolError(
        'chunk-sequence-mismatch',
        `rpc_chunk sequence "${metadata.chunkId}" metadata or ordering does not match the tracked sequence.`
      );
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    this.inflightReassemblyBytes += bytes.byteLength;
    if (this.inflightReassemblyBytes > this.limits.maxInflightReassemblyBytes) {
      throw new OmpRpcProtocolError(
        'inflight-reassembly-bytes-exceeded',
        `Total in-flight rpc_chunk reassembly bytes exceed the ${this.limits.maxInflightReassemblyBytes}-byte limit.`
      );
    }
    if (pending.receivedBytes > pending.byteLength) {
      throw new OmpRpcProtocolError(
        'chunk-sequence-exceeds-declared-length',
        `rpc_chunk sequence "${metadata.chunkId}" received more bytes than its declared byteLength.`
      );
    }
    pending.nextIndex += 1;
    if (pending.nextIndex < pending.count) return null;

    this.pendingReassemblies.delete(metadata.chunkId);
    this.inflightReassemblyBytes -= pending.receivedBytes;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new OmpRpcProtocolError(
        'chunk-sequence-length-mismatch',
        `rpc_chunk sequence "${metadata.chunkId}" completed with ${pending.receivedBytes} bytes but declared ${pending.byteLength}.`
      );
    }

    const decodedText = decodeStrictUtf8(Buffer.concat(pending.chunks));
    let reassembled: unknown;
    try {
      reassembled = JSON.parse(decodedText);
    } catch {
      throw new OmpRpcProtocolError(
        'malformed-json-in-reassembled-frame',
        `rpc_chunk sequence "${metadata.chunkId}" reassembled into invalid JSON.`
      );
    }
    if (!isRecord(reassembled)) {
      throw new OmpRpcProtocolError(
        'non-object-reassembled-frame',
        `rpc_chunk sequence "${metadata.chunkId}" reassembled into a non-object JSON value.`
      );
    }
    return toReassembledFrame(reassembled, metadata.chunkId);
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
