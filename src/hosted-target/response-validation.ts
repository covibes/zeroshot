import { TargetProtocolError } from './errors.ts';
import { KNOWN_CAPSULE_STATES } from './types.ts';
import type { Capsule, CapsuleAccess, CapsuleLimits, CapsuleListPage } from './types.ts';

export function assertRequiredFields(
  body: unknown,
  fields: readonly string[],
  context: string,
): asserts body is Record<string, unknown> {
  if (body === null || typeof body !== 'object') {
    throw new TargetProtocolError(`${context}: expected object, got ${typeof body}`);
  }
  const record = body as Record<string, unknown>;
  for (const field of fields) {
    if (record[field] === undefined || record[field] === null) {
      throw new TargetProtocolError(`${context}: missing required field "${field}"`);
    }
  }
}

export function assertKnownEnum(value: string, known: readonly string[], field: string): void {
  if (!known.includes(value)) {
    // eslint-disable-next-line no-console
    console.warn(`Unknown ${field} value: "${value}". Known values: ${known.join(', ')}`);
  }
}

export function assertCapsule(body: unknown): Capsule {
  assertRequiredFields(body, ['id', 'state', 'createdAt'], 'Capsule');
  const record = body as Record<string, unknown>;
  if (typeof record['id'] !== 'string') {
    throw new TargetProtocolError('Capsule: "id" must be a string');
  }
  if (typeof record['state'] !== 'string') {
    throw new TargetProtocolError('Capsule: "state" must be a string');
  }
  if (typeof record['createdAt'] !== 'string') {
    throw new TargetProtocolError('Capsule: "createdAt" must be a string');
  }
  assertKnownEnum(record['state'] as string, KNOWN_CAPSULE_STATES, 'CapsuleState');
  return record as unknown as Capsule;
}

export function assertCapsuleAccess(body: unknown): CapsuleAccess {
  assertRequiredFields(body, ['endpoint', 'token', 'expiresAt'], 'CapsuleAccess');
  const record = body as Record<string, unknown>;
  if (typeof record['endpoint'] !== 'string') {
    throw new TargetProtocolError('CapsuleAccess: "endpoint" must be a string');
  }
  if (typeof record['token'] !== 'string') {
    throw new TargetProtocolError('CapsuleAccess: "token" must be a string');
  }
  if (typeof record['expiresAt'] !== 'string') {
    throw new TargetProtocolError('CapsuleAccess: "expiresAt" must be a string');
  }
  return record as unknown as CapsuleAccess;
}

export function assertCapsuleLimits(body: unknown): CapsuleLimits {
  assertRequiredFields(body, ['maxConcurrent', 'maxPerHour'], 'CapsuleLimits');
  const record = body as Record<string, unknown>;
  if (typeof record['maxConcurrent'] !== 'number') {
    throw new TargetProtocolError('CapsuleLimits: "maxConcurrent" must be a number');
  }
  if (typeof record['maxPerHour'] !== 'number') {
    throw new TargetProtocolError('CapsuleLimits: "maxPerHour" must be a number');
  }
  return record as unknown as CapsuleLimits;
}

export function assertCapsuleListPage(body: unknown): CapsuleListPage {
  assertRequiredFields(body, ['items'], 'CapsuleListPage');
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record['items'])) {
    throw new TargetProtocolError('CapsuleListPage: "items" must be an array');
  }
  const items = (record['items'] as unknown[]).map((item) => assertCapsule(item));
  const cursor = record['cursor'];
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new TargetProtocolError('CapsuleListPage: "cursor" must be a string if present');
  }
  if (typeof cursor === 'string') {
    return { items, cursor };
  }
  return { items };
}
