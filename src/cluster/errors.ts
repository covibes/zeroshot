import type { DomainErrorData } from './generated/protocol.js';

export class ClusterError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ClusterConfigError extends ClusterError {}
export class ClusterStateError extends ClusterError {}
export class ClusterInternalError extends ClusterError {}
export class ClusterProtocolError extends ClusterError {}
export class ClusterTransportError extends ClusterError {}
export class ClusterTimeoutError extends ClusterError {}
export class ClusterRequestError extends ClusterError {}

export function requestAbortError(method: string): DOMException {
  return new DOMException(
    `${method} aborted locally; the server may still have committed this request`,
    'AbortError',
  );
}

export class ClusterRpcError extends ClusterError {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: DomainErrorData,
  ) {
    super(message, data?.code ?? String(rpcCode));
  }
}
