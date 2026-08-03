import { TargetProtocolError } from './errors.mjs';
import { KNOWN_CAPSULE_STATES } from './types.mjs';
function closedObject(body, fields, context) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TargetProtocolError(`${context} response is malformed`);
  }
  const record = body;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    throw new TargetProtocolError(`${context} response is malformed`);
  }
  return record;
}
function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}
function timestamp(value) {
  return (
    nonempty(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function uint(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
export function assertCapsule(body) {
  const value = closedObject(body, ['capsule_id', 'state', 'label', 'created_at'], 'Capsule');
  if (
    !nonempty(value.capsule_id) ||
    typeof value.state !== 'string' ||
    !KNOWN_CAPSULE_STATES.includes(value.state) ||
    (value.label !== null && typeof value.label !== 'string') ||
    !timestamp(value.created_at)
  ) {
    throw new TargetProtocolError('Capsule response is malformed');
  }
  return Object.freeze({
    id: value.capsule_id,
    state: value.state,
    label: value.label,
    createdAt: value.created_at,
  });
}
export function assertCapsuleAccess(body) {
  const value = closedObject(
    body,
    ['protocol', 'websocket_url', 'access_token', 'token_type', 'expires_at'],
    'CapsuleAccess'
  );
  if (
    value.protocol !== 'openengine.cluster/v1' ||
    !nonempty(value.websocket_url) ||
    !nonempty(value.access_token) ||
    value.token_type !== 'Bearer' ||
    !timestamp(value.expires_at)
  ) {
    throw new TargetProtocolError('CapsuleAccess response is malformed');
  }
  return Object.freeze({
    protocol: 'openengine.cluster/v1',
    websocketUrl: value.websocket_url,
    accessToken: value.access_token,
    tokenType: 'Bearer',
    expiresAt: value.expires_at,
  });
}
export function assertCapsuleLimits(body) {
  const value = closedObject(body, ['active_capsules', 'max_active_capsules'], 'CapsuleLimits');
  if (
    !uint(value.active_capsules) ||
    (value.max_active_capsules !== null && !uint(value.max_active_capsules))
  ) {
    throw new TargetProtocolError('CapsuleLimits response is malformed');
  }
  return Object.freeze({
    activeCapsules: value.active_capsules,
    maxActiveCapsules: value.max_active_capsules,
  });
}
export function assertCapsuleListPage(body) {
  const value = closedObject(body, ['capsules', 'next_cursor'], 'CapsulePage');
  if (
    !Array.isArray(value.capsules) ||
    (value.next_cursor !== null && typeof value.next_cursor !== 'string')
  ) {
    throw new TargetProtocolError('CapsulePage response is malformed');
  }
  return Object.freeze({
    capsules: Object.freeze(value.capsules.map((item) => assertCapsule(item))),
    nextCursor: value.next_cursor,
  });
}
