import type { PayloadType } from './generated/protocol.js';
import { ClusterRequestError } from './errors.js';

export type InputValidationIssue = {
  readonly path: string;
  readonly code: 'TYPE_MISMATCH' | 'MISSING_REQUIRED_FIELD' | 'UNKNOWN_FIELD' | 'UNKNOWN_ENUM_LABEL';
};

type InternalIssue = InputValidationIssue & { readonly expectedKind: string };

function isJsonInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function evaluate(type: PayloadType, value: unknown, path: string): InternalIssue | null {
  switch (type.kind) {
    case 'null':
      return value === null ? null : { path, code: 'TYPE_MISMATCH', expectedKind: 'null' };
    case 'boolean':
      return typeof value === 'boolean' ? null : { path, code: 'TYPE_MISMATCH', expectedKind: 'boolean' };
    case 'integer':
      return isJsonInteger(value) ? null : { path, code: 'TYPE_MISMATCH', expectedKind: 'integer' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : { path, code: 'TYPE_MISMATCH', expectedKind: 'number' };
    case 'string':
      return typeof value === 'string' ? null : { path, code: 'TYPE_MISMATCH', expectedKind: 'string' };
    case 'enum':
      if (typeof value !== 'string') return { path, code: 'TYPE_MISMATCH', expectedKind: 'enum' };
      return type.values.includes(value)
        ? null
        : { path, code: 'UNKNOWN_ENUM_LABEL', expectedKind: 'enum' };
    case 'array': {
      if (!Array.isArray(value)) return { path, code: 'TYPE_MISMATCH', expectedKind: 'array' };
      for (let index = 0; index < value.length; index += 1) {
        const issue = evaluate(type.items, value[index], `${path}/${index}`);
        if (issue) return issue;
      }
      return null;
    }
    case 'record': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { path, code: 'TYPE_MISMATCH', expectedKind: 'record' };
      }
      const record = value as Readonly<Record<string, unknown>>;
      const fieldNames = Object.keys(type.fields).sort();
      for (const name of fieldNames) {
        const field = type.fields[name];
        if (!field) continue;
        const fieldPath = `${path}/${name}`;
        if (Object.prototype.hasOwnProperty.call(record, name)) {
          const issue = evaluate(field.type, record[name], fieldPath);
          if (issue) return issue;
        } else if (field.required) {
          return { path: fieldPath, code: 'MISSING_REQUIRED_FIELD', expectedKind: field.type.kind };
        }
      }
      const declared = new Set(fieldNames);
      const unknownField = Object.keys(record).sort().find((name) => !declared.has(name));
      return unknownField
        ? { path: `${path}/${unknownField}`, code: 'UNKNOWN_FIELD', expectedKind: 'record' }
        : null;
    }
  }
}

export function firstInputValidationIssue(
  type: PayloadType,
  value: unknown,
  path = '',
): InputValidationIssue | null {
  const issue = evaluate(type, value, path);
  return issue ? { path: issue.path, code: issue.code } : null;
}

export function assertInputValue(type: PayloadType, value: unknown): void {
  const issue = evaluate(type, value, '');
  if (!issue) return;
  throw new ClusterRequestError(
    `input value at '${issue.path || '/'}' failed validation: ${issue.code}, expected ${issue.expectedKind}`,
    'INVALID_INPUT',
  );
}
