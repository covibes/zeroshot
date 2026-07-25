/**
 * Public error hierarchy for the `cluster` client, mirroring `openengine_cluster_client::
 * ClientError` (crates/openengine-cluster-client/src/lib.rs), prefixed `Cluster*` for a clean
 * namespace in userland (this package's default entrypoint already exports unrelated error
 * types). Every rejection a {@link ../cluster/cluster-client.js ClusterClient} method or a
 * subscription client can produce is an instance of {@link ClusterClientError}.
 */

import type { JsonRpcError } from './generated/wire-types.js';
import { TransportError } from './transport.js';

export abstract class ClusterClientError extends Error {
  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Mirrors `ClientError::Transport`. */
export class ClusterTransportError extends ClusterClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Mirrors `ClientError::Rpc`: the server returned a JSON-RPC `error` response. */
export class ClusterRpcError extends ClusterClientError {
  readonly code: number;
  readonly data: JsonRpcError['data'];

  constructor(error: JsonRpcError) {
    super(`server returned JSON-RPC error ${error.code}: ${error.message}`);
    this.code = error.code;
    this.data = error.data ?? null;
  }
}

/** Mirrors `ClientError::InvalidResponse`: a response that parsed as JSON but did not match the
 * expected wire schema, or whose `jsonrpc`/`id` identity did not match the request. */
export class ClusterInvalidResponseError extends ClusterClientError {
  constructor(message: string) {
    super(`invalid JSON-RPC response: ${message}`);
  }
}

/** Raised when a unary call's `AbortSignal` aborted, or a subscription was cancelled locally
 * before it produced the result the caller was awaiting. Rust has no direct analog (Rust callers
 * cancel via a dropped future); this exists because `AbortSignal`/async iterator `.return()` are
 * the idiomatic JS cancellation surfaces. */
export class ClusterAbortError extends ClusterClientError {
  constructor(message = 'request aborted') {
    super(message);
  }
}

/** Wraps a raw {@link TransportError} (or any other thrown value) from the transport layer into
 * the public {@link ClusterClientError} hierarchy, mirroring Rust's `#[from] TransportError`
 * conversion into `ClientError::Transport`. */
export function toClusterClientError(error: unknown): ClusterClientError {
  if (error instanceof ClusterClientError) {
    return error;
  }
  if (error instanceof TransportError) {
    return new ClusterTransportError(error.message, { cause: error });
  }
  if (error instanceof Error) {
    return new ClusterTransportError(error.message, { cause: error });
  }
  return new ClusterTransportError(String(error));
}
