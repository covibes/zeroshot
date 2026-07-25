import type * as Wire from './generated/wire-types.js';

/** Base class for every error this client raises. */
export abstract class ClusterProtocolError extends Error {}

/** A transport-level failure: the socket closed, never opened, or a send failed. */
export class TransportError extends ClusterProtocolError {
  public constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** A message was received that does not conform to the Cluster Protocol v1 JSON-RPC envelope. */
export class InvalidResponseError extends ClusterProtocolError {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

/**
 * The server returned a JSON-RPC error for a request. `data.code` mirrors the Rust backend's
 * `pub const` domain error codes (see the `*_CODE` constants exported below) but is typed as a
 * bare `string`, not a closed union -- `schema.json#/$defs/DomainErrorData` defines it that way
 * so the client never rejects a server-added code it doesn't recognize yet.
 */
export class RpcError extends ClusterProtocolError {
  public readonly code: number;
  public readonly data: Wire.DomainErrorData | null;

  public constructor(error: Wire.JsonRpcError) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data ?? null;
  }
}

/** A unary call's `AbortSignal` fired, or a subscription was cancelled locally. */
export class AbortError extends ClusterProtocolError {
  public constructor(message = 'the operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Named domain error data codes mirroring the Rust backend's `pub const` values
 * (`crates/openengine-cluster-protocol/src/{admission,watch}.rs`). Provided for ergonomics only
 * -- `RpcError.data.code` is typed as a bare `string`, never this closed set, since the wire
 * contract itself never closes it.
 */
export const GRAPH_INVALID = 'GRAPH_INVALID';
export const SCHEMA_VIOLATION = 'SCHEMA_VIOLATION';
export const GENERATION_CONFLICT = 'GENERATION_CONFLICT';
export const RUN_CONFLICT = 'RUN_CONFLICT';
export const IDEMPOTENCY_REUSE = 'IDEMPOTENCY_REUSE';
export const INVALID_PHASE = 'INVALID_PHASE';
export const CANCELLED = 'CANCELLED';
export const NO_RETRYABLE_FRONTIER = 'NO_RETRYABLE_FRONTIER';
export const NOT_FOUND = 'NOT_FOUND';
export const GONE = 'GONE';
export const SLOW_CONSUMER = 'SLOW_CONSUMER';
export const UNSUPPORTED_PROTOCOL_VERSION = 'UNSUPPORTED_PROTOCOL_VERSION';
