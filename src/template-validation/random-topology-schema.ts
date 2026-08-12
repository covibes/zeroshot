import type { RandomAgentConfig, RandomNumberGenerator } from './random-topology-contracts';

type SchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null;
}

export function createSeededRng(seed: number): RandomNumberGenerator {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

function randomInt(rng: RandomNumberGenerator, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  if (max <= min) {
    return Math.round(min);
  }
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomPick<T>(
  rng: RandomNumberGenerator,
  values: readonly T[],
  fallback: T
): T | undefined {
  if (values.length === 0) {
    return fallback;
  }
  return values[randomInt(rng, 0, values.length - 1)];
}

function normalizeType(schema: SchemaRecord): unknown {
  if (!schema.type) return null;
  if (Array.isArray(schema.type)) {
    return schema.type[0] ?? null;
  }
  return schema.type;
}

function sampleString(schema: SchemaRecord, rng: RandomNumberGenerator): string {
  const candidates = stringCandidates(schema);
  let value = randomPick(rng, candidates, 'sample');
  if (value === undefined) value = 'sample';

  const minLength = Number.isInteger(schema.minLength) ? Number(schema.minLength) : 0;
  const maxLength = Number.isInteger(schema.maxLength) ? Number(schema.maxLength) : value.length;

  while (value.length < minLength) value += 'x';
  if (maxLength >= 0 && value.length > maxLength) value = value.slice(0, maxLength);
  if (!value && minLength > 0) value = 'x'.repeat(minLength);
  return value;
}

function stringCandidates(schema: SchemaRecord): string[] {
  const candidates: string[] = [];
  if (typeof schema.default === 'string') candidates.push(schema.default);
  if (typeof schema.description === 'string') candidates.push(schema.description);
  candidates.push('sample', 'ok', 'done', 'pass', 'fail');
  return candidates;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sampleNumber(
  schema: SchemaRecord,
  rng: RandomNumberGenerator,
  asInteger: boolean
): number {
  const minimum = finiteNumber(schema.minimum, 0);
  const maximum = finiteNumber(schema.maximum, 10);
  if (maximum < minimum) {
    return asInteger ? Math.round(minimum) : minimum;
  }
  if (asInteger) {
    return randomInt(rng, Math.ceil(minimum), Math.floor(maximum));
  }
  return minimum + (maximum - minimum) * rng();
}

function sampleArray(schema: SchemaRecord, rng: RandomNumberGenerator, depth: number): unknown[] {
  const minItems = Number.isInteger(schema.minItems) ? Number(schema.minItems) : 0;
  const rawMaximum = Number.isInteger(schema.maxItems) ? Number(schema.maxItems) : minItems + 2;
  const maxItems = Math.max(minItems, Math.min(rawMaximum, 3));
  const length = randomInt(rng, minItems, maxItems);
  const itemsSchema = Array.isArray(schema.items)
    ? randomPick<unknown>(rng, schema.items, {})
    : schema.items || {};
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(sampleFromSchema(itemsSchema, rng, depth + 1));
  }
  return values;
}

function sampleObject(
  schema: SchemaRecord,
  rng: RandomNumberGenerator,
  depth: number
): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const value: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    value[key] = sampleFromSchema(propertySchema, rng, depth + 1);
  }
  return value;
}

type SampleBranch = { matched: true; value: unknown } | { matched: false };

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function sampleSchemaKeyword(
  schema: SchemaRecord,
  rng: RandomNumberGenerator,
  depth: number
): SampleBranch {
  if (schema.const !== undefined) return { matched: true, value: schema.const };
  if (isNonEmptyArray(schema.enum)) {
    return { matched: true, value: randomPick<unknown>(rng, schema.enum, null) };
  }
  if (isNonEmptyArray(schema.oneOf)) {
    const selected = randomPick<unknown>(rng, schema.oneOf, null);
    return { matched: true, value: sampleFromSchema(selected, rng, depth + 1) };
  }
  if (isNonEmptyArray(schema.anyOf)) {
    const selected = randomPick<unknown>(rng, schema.anyOf, null);
    return { matched: true, value: sampleFromSchema(selected, rng, depth + 1) };
  }
  if (isNonEmptyArray(schema.allOf)) {
    return { matched: true, value: sampleFromSchema(schema.allOf[0], rng, depth + 1) };
  }
  return { matched: false };
}

function sampleSchemaType(
  schema: SchemaRecord,
  rng: RandomNumberGenerator,
  depth: number
): SampleBranch {
  const type = normalizeType(schema);
  if (type === 'boolean') return { matched: true, value: rng() >= 0.5 };
  if (type === 'integer') return { matched: true, value: sampleNumber(schema, rng, true) };
  if (type === 'number') return { matched: true, value: sampleNumber(schema, rng, false) };
  if (type === 'array') return { matched: true, value: sampleArray(schema, rng, depth) };
  if (type === 'object' || schema.properties) {
    return { matched: true, value: sampleObject(schema, rng, depth) };
  }
  return { matched: false };
}

export function sampleFromSchema(
  schemaValue: unknown,
  rng: RandomNumberGenerator,
  depth = 0
): unknown {
  if (!isRecord(schemaValue) || depth > 4) {
    return null;
  }
  const keyword = sampleSchemaKeyword(schemaValue, rng, depth);
  if (keyword.matched) return keyword.value;
  const typed = sampleSchemaType(schemaValue, rng, depth);
  if (typed.matched) return typed.value;
  return sampleString(schemaValue, rng);
}

export function sampleResultData(
  agentConfig: RandomAgentConfig,
  rng: RandomNumberGenerator
): unknown {
  const schema = agentConfig.jsonSchema || agentConfig.structuredOutput || null;
  if (schema) {
    return sampleFromSchema(schema, rng);
  }
  return { summary: 'sample', result: 'sample' };
}
