import { invalidField } from '../contract-errors';
import { isRecord } from '../json';
import { LEVELS, PROVIDER_ID } from './sdk-settings-constants';
import type { OmpModelLevel } from './sdk-settings-types';

export function safeUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    invalidField(field, `${field} must be a non-empty URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidField(field, `${field} must be an absolute URL.`);
  }
  if (parsed.username || parsed.password) {
    invalidField(field, `${field} must not contain URL userinfo.`);
  }
  if (parsed.search || parsed.hash) {
    invalidField(field, `${field} must not contain query parameters or fragments.`);
  }
  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    invalidField(field, `${field} must use HTTPS, except for loopback HTTP providers.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function emptyHeaders(value: unknown, field: string): Record<string, never> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  if (Object.keys(value).length !== 0) {
    invalidField(field, 'Literal custom headers may persist credentials and are not accepted.');
  }
  return {};
}

export function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    invalidField(`${field}.${unknown}`, `Unknown OMP setting: ${field}.${unknown}.`);
  }
}

export function levelValue(value: unknown, field: string): OmpModelLevel {
  return enumValue(value, LEVELS, field);
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  invalidField(field, `${field} must be one of: ${allowed.join(', ')}.`);
}

export function falseOnly(value: unknown, field: string): false {
  if (value === false) return false;
  invalidField(field, `${field} must be false.`);
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  invalidField(field, `${field} must be a boolean.`);
}

export function nonEmptyString(value: unknown, field: string): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\0')
  ) {
    return value;
  }
  invalidField(field, `${field} must be a non-empty string without surrounding whitespace.`);
}

export function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  invalidField(field, `${field} must be a finite non-negative number.`);
}

export function assertProviderId(provider: string, field: string): void {
  if (!PROVIDER_ID.test(provider)) {
    invalidField(
      field,
      'OMP provider IDs must use lowercase letters, numbers, dots, underscores, or hyphens.'
    );
  }
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableValue(value[key])])
  );
}

export function deepFreeze<T>(value: T): Readonly<T> {
  const candidate: unknown = value;
  if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) {
    return value;
  }
  for (const item of Object.values(candidate)) deepFreeze(item);
  Object.freeze(candidate);
  return value;
}
