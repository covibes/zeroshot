import { InvalidResponseError, RpcError } from './errors.js';
import { isRecord, parseJson } from './json-guards.js';
import type { DomainErrorData, RequestId } from './wire-types.generated.js';

export type { RequestId };

export const JSON_RPC_VERSION = '2.0';
export const PROTOCOL_VERSION = 'openengine.cluster/v1';

/**
 * Hand-written generic JSON-RPC envelope. The protocol schemas monomorphize this once per distinct
 * `params`/`result` type (`JsonRpcRequest`, `JsonRpcRequest2`, ...); this single generic supersedes
 * all of them so callers get one parameterized type instead of N structurally-identical ones.
 */
export interface JsonRpcRequest<P> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: string;
  readonly params: P;
}

export interface JsonRpcNotification<P> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params: P;
}

export interface JsonRpcSuccess<R> {
  readonly jsonrpc: string;
  readonly id: RequestId;
  readonly result: R;
}

export function requestIdKey(id: RequestId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

export function requestIdsEqual(a: RequestId | null | undefined, b: RequestId): boolean {
  if (a === null || a === undefined) return false;
  return requestIdKey(a) === requestIdKey(b);
}

/** @returns the decoded id, or `null` if `value` is not a valid JSON-RPC id shape. */
function extractRequestId(value: unknown): RequestId | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

function toDomainErrorData(value: unknown): DomainErrorData | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  if (typeof code !== 'string') return undefined;
  return { code, details: 'details' in value ? value.details : undefined };
}

export function validateResponseIdentity(
  jsonrpc: string,
  actualId: RequestId | null,
  expectedId: RequestId
): void {
  if (jsonrpc !== JSON_RPC_VERSION) {
    throw new InvalidResponseError(`expected jsonrpc ${JSON_RPC_VERSION}, received ${jsonrpc}`);
  }
  if (actualId === null || requestIdKey(actualId) !== requestIdKey(expectedId)) {
    throw new InvalidResponseError(
      `response id mismatch: expected ${requestIdKey(expectedId)}, received ${
        actualId === null ? 'none' : requestIdKey(actualId)
      }`
    );
  }
}

/**
 * Parses one demultiplexed unary response line into its typed result, throwing {@link RpcError} for
 * a well-formed JSON-RPC error and {@link InvalidResponseError} for anything malformed or whose
 * `jsonrpc`/`id` does not match `expectedId`. `R` is trusted at the JSON boundary the same way
 * `serde_json::from_value::<R>` is trusted in the Rust client — this crate does not re-validate
 * every generated wire type's shape at runtime.
 */
export function parseUnaryResponseLine<R>(line: string, expectedId: RequestId): R {
  const value: unknown = parseJson(line);
  if (!isRecord(value)) throw new InvalidResponseError('response is not a JSON object');
  const jsonrpc = value.jsonrpc;
  if (typeof jsonrpc !== 'string') throw new InvalidResponseError('response missing jsonrpc field');
  const actualId = extractRequestId(value.id);

  if ('error' in value) {
    const errorValue = value.error;
    if (!isRecord(errorValue) || typeof errorValue.code !== 'number' || typeof errorValue.message !== 'string') {
      throw new InvalidResponseError('malformed JSON-RPC error response');
    }
    validateResponseIdentity(jsonrpc, actualId, expectedId);
    throw new RpcError({
      code: errorValue.code,
      message: errorValue.message,
      data: toDomainErrorData(errorValue.data),
    });
  }

  validateResponseIdentity(jsonrpc, actualId, expectedId);
  // Trust the wire boundary for the result payload shape, exactly like `serde_json::from_value::<R>`
  // does in the Rust client — this module does not re-validate every generated wire type at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return value.result as R;
}
