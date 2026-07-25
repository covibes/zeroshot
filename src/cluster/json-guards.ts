import {InvalidResponseError} from './errors.js';
import type * as Wire from './generated/wire-types.js';

/** JSON-RPC protocol version literal this client speaks -- matches the Rust `JSON_RPC_VERSION`. */
export const JSON_RPC_VERSION = '2.0';

/**
 * A generic outgoing JSON-RPC request envelope. Hand-written rather than generated: JSON Schema
 * cannot express "params/result typed per the `method` field", so the generated wire types instead
 * carry one `JsonRpcRequest`/`JsonRpcSuccess` definition per Rust monomorphization. This envelope
 * is generic over `M`/`P` instead and is validated against {@link JSON_RPC_VERSION} at the call
 * site, not re-derived from the generated schema output.
 */
export interface JsonRpcRequestEnvelope<M extends string = string, P = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: Wire.RequestId;
  method: M;
  params: P;
}

/** A generic outgoing JSON-RPC notification envelope (no `id`, no response). */
export interface JsonRpcNotificationEnvelope<M extends string = string, P = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: M;
  params: P;
}

/** One incoming message, narrowed from raw `unknown` JSON to a tagged union. */
export type IncomingMessage =
  | {kind: 'success'; id: Wire.RequestId; result: unknown}
  | {kind: 'error'; id: Wire.RequestId | null; error: Wire.JsonRpcError}
  | {kind: 'notification'; method: string; params: unknown};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is Wire.RequestId {
  return typeof value === 'string' || typeof value === 'number';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isDomainErrorData(value: unknown): value is Wire.DomainErrorData {
  return isRecord(value) && typeof value['code'] === 'string';
}

function isJsonRpcError(value: unknown): value is Wire.JsonRpcError {
  if (!isRecord(value)) return false;
  if (typeof value['code'] !== 'number') return false;
  if (typeof value['message'] !== 'string') return false;
  const data = value['data'];
  if (data !== undefined && data !== null && !isDomainErrorData(data)) return false;
  return true;
}

/**
 * Parses one raw WebSocket text frame into an {@link IncomingMessage}. Throws
 * {@link InvalidResponseError} for anything that is not a well-formed JSON-RPC
 * {@link JSON_RPC_VERSION} success response, error response, or notification.
 */
export function parseIncomingMessage(raw: string): IncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new InvalidResponseError(`failed to parse JSON-RPC message: ${errorMessage(cause)}`);
  }

  if (!isRecord(value) || value['jsonrpc'] !== JSON_RPC_VERSION) {
    throw new InvalidResponseError(`expected a JSON-RPC ${JSON_RPC_VERSION} message`);
  }

  const method = value['method'];
  if (typeof method === 'string') {
    return {kind: 'notification', method, params: value['params']};
  }

  if ('error' in value) {
    const error = value['error'];
    if (!isJsonRpcError(error)) {
      throw new InvalidResponseError('malformed JSON-RPC error response');
    }
    const id = value['id'];
    if (id !== null && id !== undefined && !isRequestId(id)) {
      throw new InvalidResponseError('malformed JSON-RPC error response id');
    }
    return {kind: 'error', id: id === null || id === undefined ? null : id, error};
  }

  if ('result' in value) {
    const id = value['id'];
    if (!isRequestId(id)) {
      throw new InvalidResponseError('malformed JSON-RPC success response id');
    }
    return {kind: 'success', id, result: value['result']};
  }

  throw new InvalidResponseError('unrecognized JSON-RPC message shape');
}

/** Narrows a `watch` subscription's `event` notification params. */
export function isEventNotificationParams(value: unknown): value is Wire.EventNotification {
  return (
    isRecord(value) &&
    typeof value['subscriptionId'] === 'string' &&
    typeof value['runId'] === 'string' &&
    typeof value['cursor'] === 'string' &&
    isRecord(value['event'])
  );
}

/** Narrows a `logs` subscription's `event` notification params. */
export function isLogEventNotificationParams(
  value: unknown
): value is Wire.LogEventNotificationWire {
  return (
    isRecord(value) && typeof value['subscriptionId'] === 'string' && isRecord(value['record'])
  );
}

/** Narrows an `agent/attach` subscription's `event` notification params. */
export function isAgentAttachEventNotificationParams(
  value: unknown
): value is Wire.AgentAttachEventNotification {
  return (
    isRecord(value) && typeof value['subscriptionId'] === 'string' && isRecord(value['event'])
  );
}

/** Narrows a generic (`watch`) `subscription/closed` notification. */
export function isSubscriptionClosedParams(
  value: unknown
): value is Wire.SubscriptionClosedNotification {
  if (!isRecord(value)) return false;
  if (typeof value['subscriptionId'] !== 'string') return false;
  if (value['reason'] !== 'done' && value['reason'] !== 'SLOW_CONSUMER') return false;
  const cursor = value['lastDeliveredCursor'];
  return cursor === undefined || cursor === null || typeof cursor === 'string';
}

/** Shared shape of the `logs`/`agent-attach` "cursorless" terminal close notifications. */
function isCursorlessClosedParams(value: unknown): value is {subscriptionId: string; reason: Wire.SubscriptionCloseReason} {
  return (
    isRecord(value) &&
    typeof value['subscriptionId'] === 'string' &&
    (value['reason'] === 'done' || value['reason'] === 'SLOW_CONSUMER')
  );
}

/** Narrows a `logs` subscription's terminal `subscription/closed` notification (no cursor). */
export function isLogsClosedParams(value: unknown): value is Wire.LogsClosedNotification {
  return isCursorlessClosedParams(value);
}

/**
 * Narrows an `agent/attach` subscription's terminal `subscription/closed` notification (no
 * cursor).
 */
export function isAgentAttachClosedParams(
  value: unknown
): value is Wire.AgentAttachClosedNotification {
  return isCursorlessClosedParams(value);
}

/** Extracts `subscriptionId` from an establishment result shared by watch/logs/agent-attach. */
export function extractSubscriptionId(result: unknown): string | null {
  if (isRecord(result) && typeof result['subscriptionId'] === 'string') {
    return result['subscriptionId'];
  }
  return null;
}
