import Ajv from 'ajv';

import { contractError } from '../contract-errors';
import { parseExactOmpModelSelector } from './sdk-settings';
const MAX_RUN_ID_BYTES = 128;
const MAX_SELECTOR_BYTES = 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_SCHEMA_STRING_BYTES = 16 * 1024;
const MAX_SCHEMA_ARRAY_ITEMS = 4_096;
const MAX_SCHEMA_OBJECT_KEYS = 4_096;
const MAX_SCHEMA_KEY_BYTES = 1_024;
const UNSAFE_REGEX_SCHEMA_KEYWORDS: Readonly<Record<string, true>> = {
  pattern: true,
  patternProperties: true,
};

export type Fail = (message: string, field?: string) => never;
export function includesLiteral<T extends string>(
  values: readonly T[],
  value: unknown
): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}
function failure(code: string, message: string, field?: string): never {
  throw contractError({ code, message, exitCode: 2, ...(field === undefined ? {} : { field }) });
}
export function protocolFailure(message: string, field?: string): never {
  return failure('omp-sdk-protocol', message, field);
}
export function requestFailure(message: string, field?: string): never {
  return failure('invalid-omp-sdk-request', message, field);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function exact(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  subject: string,
  fail: Fail
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(`${subject}.${key} is required.`, `${subject}.${key}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${subject}.${key} is not allowed.`, `${subject}.${key}`);
  }
}
export function string(
  value: unknown,
  field: string,
  maxBytes: number,
  empty: boolean,
  fail: Fail
): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) {
    return fail(`${field} must be ${empty ? 'a string' : 'a non-empty string'}.`, field);
  }
  if (Buffer.byteLength(value) > maxBytes)
    return fail(`${field} exceeds ${maxBytes} bytes.`, field);
  return value;
}
export function parseRunId(value: unknown, field: string, fail: Fail): string {
  const parsed = string(value, field, MAX_RUN_ID_BYTES, false, fail);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed)) {
    fail(`${field} contains unsupported characters.`, field);
  }
  return parsed;
}
export function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
  fail: Fail
): T {
  if (value !== expected) return fail(`${field} must be ${JSON.stringify(expected)}.`, field);
  return expected;
}
export function number(value: unknown, field: string, integer: boolean): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    protocolFailure(`${field} must be a finite nonnegative${integer ? ' integer' : ''}.`, field);
  }
  return value;
}
export function json(value: unknown, field: string, fail: Fail): void {
  const stack: Array<{ value: unknown; depth: number; field: string }> = [
    { value, depth: 0, field },
  ];
  const seen = new Set<object>();
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (++count > MAX_JSON_NODES) fail(`${field} exceeds ${MAX_JSON_NODES} JSON nodes.`, field);
    if (item.depth > MAX_JSON_DEPTH) fail(`${field} exceeds JSON depth ${MAX_JSON_DEPTH}.`, field);
    const current = item.value;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== 'object')
      fail(`${item.field} must contain only JSON values.`, item.field);
    if (seen.has(current))
      fail(`${item.field} must not contain shared or cyclic objects.`, item.field);
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((child, index) =>
        stack.push({ value: child, depth: item.depth + 1, field: `${item.field}[${index}]` })
      );
    } else {
      const prototype = Reflect.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail(`${item.field} must contain plain JSON objects.`, item.field);
      }
      Object.entries(current).forEach(([key, child]) =>
        stack.push({ value: child, depth: item.depth + 1, field: `${item.field}.${key}` })
      );
    }
  }
}
export function serializedLimit(value: unknown, max: number, subject: string, fail: Fail): void {
  let encoded: unknown;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${subject} is not JSON serializable.`);
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > max) {
    fail(`${subject} exceeds ${max} bytes.`);
  }
}
export function selector(value: unknown, field: string, fail: Fail): string {
  const parsed = string(value, field, MAX_SELECTOR_BYTES, false, fail);
  try {
    parseExactOmpModelSelector(parsed);
  } catch {
    fail(`${field} must be an exact full provider/model selector.`, field);
  }
  return parsed;
}
export function validateSchemaSafety(schema: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly field: string }> = [
    { value: schema, field: 'request.outputSchema' },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value === 'string') {
      if (Buffer.byteLength(item.value) > MAX_SCHEMA_STRING_BYTES) {
        requestFailure(`${item.field} exceeds ${MAX_SCHEMA_STRING_BYTES} bytes.`, item.field);
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (item.value.length > MAX_SCHEMA_ARRAY_ITEMS) {
        requestFailure(`${item.field} exceeds ${MAX_SCHEMA_ARRAY_ITEMS} items.`, item.field);
      }
      item.value.forEach((value, index) => stack.push({ value, field: `${item.field}[${index}]` }));
      continue;
    }
    if (!isRecord(item.value)) continue;
    const entries = Object.entries(item.value);
    if (entries.length > MAX_SCHEMA_OBJECT_KEYS) {
      requestFailure(`${item.field} exceeds ${MAX_SCHEMA_OBJECT_KEYS} properties.`, item.field);
    }
    for (const [key, value] of entries) {
      if (Buffer.byteLength(key) > MAX_SCHEMA_KEY_BYTES) {
        requestFailure(`${item.field} has an oversized keyword or property name.`, item.field);
      }
      const field = `${item.field}.${key}`;
      if (UNSAFE_REGEX_SCHEMA_KEYWORDS[key] === true) {
        requestFailure(
          `${field} is forbidden because regular-expression schemas are not accepted.`,
          field
        );
      }
      stack.push({ value, field });
    }
  }
}
function deepFreezeJson(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child) => deepFreezeJson(child));
  } else if (isRecord(value)) {
    Object.values(value).forEach((child) => deepFreezeJson(child));
  }
  Object.freeze(value);
}
/** @returns A deeply frozen boolean or object JSON Schema snapshot. */
export function immutableJsonSnapshot(value: unknown): boolean | Readonly<Record<string, unknown>> {
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== 'string') {
    requestFailure('request.outputSchema is not JSON serializable.');
  }
  const parsed: unknown = JSON.parse(encoded);
  if (typeof parsed !== 'boolean' && !isRecord(parsed)) {
    requestFailure('request.outputSchema must be a JSON Schema object or boolean.');
  }
  deepFreezeJson(parsed);
  return parsed;
}
export function schemaValidator(
  schema: boolean | Readonly<Record<string, unknown>>
): (value: unknown) => boolean {
  try {
    const validate = new Ajv({
      allErrors: true,
      coerceTypes: false,
      strict: false,
      validateFormats: false,
    }).compile(schema);
    return (value: unknown): boolean => validate(value) === true;
  } catch {
    return requestFailure(
      'request.outputSchema must be a valid JSON Schema.',
      'request.outputSchema'
    );
  }
}
