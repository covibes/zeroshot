import { TargetProtocolError } from './errors.js';
import { KNOWN_CAPSULE_STATES } from './types.js';
import type { Capsule, CapsuleAccess, CapsuleLimits, CapsuleListPage } from './types.js';

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

type TimestampParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly offsetHour: number;
  readonly offsetMinute: number;
};

function decimal(value: string, length: number): number | null {
  if (value.length !== length) return null;
  for (const character of value) {
    if (character < '0' || character > '9') return null;
  }
  return Number(value);
}

function parseDate(value: string): Pick<TimestampParts, 'year' | 'month' | 'day'> | null {
  const fields = value.split('-');
  if (fields.length !== 3) return null;
  const year = decimal(fields[0] ?? '', 4);
  const month = decimal(fields[1] ?? '', 2);
  const day = decimal(fields[2] ?? '', 2);
  if (year === null || month === null || day === null) return null;
  return { year, month, day };
}

function parseZone(value: string): {
  readonly clock: string;
  readonly offsetHour: number;
  readonly offsetMinute: number;
} | null {
  if (value.endsWith('Z')) {
    return { clock: value.slice(0, -1), offsetHour: 0, offsetMinute: 0 };
  }
  const marker = value.at(-6);
  if ((marker !== '+' && marker !== '-') || value.at(-3) !== ':') return null;
  const offsetHour = decimal(value.slice(-5, -3), 2);
  const offsetMinute = decimal(value.slice(-2), 2);
  if (offsetHour === null || offsetMinute === null) return null;
  return { clock: value.slice(0, -6), offsetHour, offsetMinute };
}

function parseFractionalClock(value: string): string | null {
  const fields = value.split('.');
  if (fields.length > 2) return null;
  const fraction = fields[1];
  if (fraction !== undefined &&
      (fraction.length === 0 || decimal(fraction, fraction.length) === null)) {
    return null;
  }
  return fields[0] ?? null;
}

function parseHms(value: string): {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} | null {
  const fields = value.split(':');
  if (fields.length !== 3) return null;
  const hour = decimal(fields[0] ?? '', 2);
  const minute = decimal(fields[1] ?? '', 2);
  const second = decimal(fields[2] ?? '', 2);
  return hour === null || minute === null || second === null ? null : { hour, minute, second };
}

function parseClock(value: string): Omit<TimestampParts, 'year' | 'month' | 'day'> | null {
  const zone = parseZone(value);
  if (zone === null) return null;
  const clock = parseFractionalClock(zone.clock);
  if (clock === null) return null;
  const parts = parseHms(clock);
  if (parts === null) return null;
  return { ...parts, offsetHour: zone.offsetHour, offsetMinute: zone.offsetMinute };
}

function parseTimestamp(value: string): TimestampParts | null {
  if (value.at(10) !== 'T') return null;
  const date = parseDate(value.slice(0, 10));
  const clock = parseClock(value.slice(11));
  return date === null || clock === null ? null : { ...date, ...clock };
}

function validClock(parts: TimestampParts): boolean {
  return parts.hour <= 23 && parts.minute <= 59 && parts.second <= 59 &&
    parts.offsetHour <= 23 && parts.offsetMinute <= 59;
}

function validCalendar(parts: TimestampParts): boolean {
  if (parts.month < 1 || parts.month > 12) return false;
  const leap = parts.year % 4 === 0 && (parts.year % 100 !== 0 || parts.year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return parts.day >= 1 && parts.day <= (days[parts.month - 1] ?? 0);
}

function timestamp(value: unknown): value is string {
  if (!nonempty(value)) return false;
  const parts = parseTimestamp(value);
  return parts !== null &&
    validClock(parts) &&
    validCalendar(parts) &&
    Number.isFinite(Date.parse(value));
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
