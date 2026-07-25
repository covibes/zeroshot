import type { DomainErrorData } from './wire-types.generated.js';

// JSON-RPC 2.0 reserved error codes plus the protocol's application-error band.
// crates/openengine-cluster-protocol/src/lib.rs:47-52 is the authoritative source.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const APPLICATION_ERROR = -32000;

export interface RpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: DomainErrorData | undefined;
}

/** Base type for every error this client throws. */
export class ClusterClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The connection/transport failed to send or receive a frame. */
export class ClusterTransportError extends ClusterClientError {
  constructor(message: string) {
    super(message);
  }
}

/** The server returned a well-formed JSON-RPC error response. */
export class RpcError extends ClusterClientError {
  readonly code: number;
  readonly data?: DomainErrorData | undefined;

  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.data = payload.data;
  }
}

/** A response could not be parsed, or its `jsonrpc`/`id` did not match the request. */
export class InvalidResponseError extends ClusterClientError {
  constructor(message: string) {
    super(message);
  }
}

/** A call was aborted locally via `AbortSignal` or async-iterator `return()`. */
export class AbortError extends ClusterClientError {
  constructor(message = 'operation aborted') {
    super(message);
  }
}

/** A subscription capability the server did not advertise was requested. */
export class CapabilityNotSupportedError extends ClusterClientError {
  constructor(capability: string) {
    super(`server does not advertise the '${capability}' capability`);
  }
}
