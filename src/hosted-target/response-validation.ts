import { TargetProtocolError } from './errors.ts';
import { KNOWN_CAPSULE_STATES } from './types.ts';
import type { Capsule, CapsuleAccess, CapsuleLimits, CapsuleListPage } from './types.ts';

function closedObject(body: unknown, fields: readonly string[], context: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TargetProtocolError(`${context} response is malformed`);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    throw new TargetProtocolError(`${context} response is malformed`);
  }
  return record;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function timestamp(value: unknown): value is string {
  return (
    nonempty(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function uint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function assertCapsule(body: unknown): Capsule {
  const value = closedObject(body, ['capsule_id', 'state', 'label', 'created_at'], 'Capsule');
  if (
    !nonempty(value.capsule_id) ||
    typeof value.state !== 'string' ||
    !KNOWN_CAPSULE_STATES.includes(value.state as Capsule['state']) ||
    (value.label !== null && typeof value.label !== 'string') ||
    !timestamp(value.created_at)
  ) {
    throw new TargetProtocolError('Capsule response is malformed');
  }
  return Object.freeze({
    id: value.capsule_id,
    state: value.state as Capsule['state'],
    label: value.label as string | null,
    createdAt: value.created_at,
  });
}

export function assertCapsuleAccess(body: unknown): CapsuleAccess {
  const value = closedObject(
    body,
    ['protocol', 'websocket_url', 'access_token', 'token_type', 'expires_at'],
    'CapsuleAccess',
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

export function assertCapsuleLimits(body: unknown): CapsuleLimits {
  const value = closedObject(body, ['active_capsules', 'max_active_capsules'], 'CapsuleLimits');
  if (!uint(value.active_capsules) || (value.max_active_capsules !== null && !uint(value.max_active_capsules))) {
    throw new TargetProtocolError('CapsuleLimits response is malformed');
  }
  return Object.freeze({
    activeCapsules: value.active_capsules,
    maxActiveCapsules: value.max_active_capsules as number | null,
  });
}

export function assertCapsuleListPage(body: unknown): CapsuleListPage {
  const value = closedObject(body, ['capsules', 'next_cursor'], 'CapsulePage');
  if (!Array.isArray(value.capsules) || (value.next_cursor !== null && typeof value.next_cursor !== 'string')) {
    throw new TargetProtocolError('CapsulePage response is malformed');
  }
  return Object.freeze({
    capsules: Object.freeze(value.capsules.map((item) => assertCapsule(item))),
    nextCursor: value.next_cursor as string | null,
  });
}
