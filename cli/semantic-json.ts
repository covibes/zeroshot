import { compareText } from './export-stream';
import {
  MAX_CONTAINER_ITEMS,
  MAX_STRING_BYTES,
  MAX_VALUE_DEPTH,
  MAX_VALUE_NODES,
} from './semantic-contract';

interface JsonBudget {
  nodes: number;
  seen: WeakSet<object>;
}

export class SemanticProjectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: object | null = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, depth: number, budget: JsonBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_VALUE_NODES) throw new SemanticProjectionError('event_shape_too_large');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_STRING_BYTES) {
      throw new SemanticProjectionError('event_string_too_large');
    }
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SemanticProjectionError('event_value_not_json');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new SemanticProjectionError('event_value_not_json');
  if (depth >= MAX_VALUE_DEPTH) throw new SemanticProjectionError('event_shape_too_deep');
  if (budget.seen.has(value)) throw new SemanticProjectionError('event_value_not_json');
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CONTAINER_ITEMS) {
        throw new SemanticProjectionError('event_shape_too_wide');
      }
      return value.map((item) => normalizeJsonValue(item, depth + 1, budget));
    }
    if (!isPlainRecord(value)) throw new SemanticProjectionError('event_value_not_json');
    const keys = Object.keys(value).sort(compareText);
    if (keys.length > MAX_CONTAINER_ITEMS) {
      throw new SemanticProjectionError('event_shape_too_wide');
    }
    const normalized: Record<string, unknown> = {};
    for (const key of keys) normalized[key] = normalizeJsonValue(value[key], depth + 1, budget);
    return normalized;
  } finally {
    budget.seen.delete(value);
  }
}

export function normalizeUnknown(value: unknown): unknown {
  return normalizeJsonValue(value, 0, { nodes: 0, seen: new WeakSet<object>() });
}
