/**
 * Schema utilities for normalizing LLM output before validation.
 *
 * LLMs may return enum values that do not exactly match the schema. Normalize
 * those values before validation without depending on a specific provider.
 */

interface EnumSchema {
  type?: string;
  enum?: string[];
  properties?: Record<string, EnumSchema>;
  items?: EnumSchema;
}

interface NormalizeEnumOptions {
  result: Record<string, unknown>;
  key: string;
  propSchema: EnumSchema;
}

const ENUM_VARIATIONS: Readonly<Record<string, string>> = {
  BUG: 'DEBUG',
  FIX: 'DEBUG',
  BUGFIX: 'DEBUG',
  BUG_FIX: 'DEBUG',
  INVESTIGATE: 'DEBUG',
  TROUBLESHOOT: 'DEBUG',
  IMPLEMENT: 'TASK',
  BUILD: 'TASK',
  CREATE: 'TASK',
  ADD: 'TASK',
  FEATURE: 'TASK',
  QUESTION: 'INQUIRY',
  ASK: 'INQUIRY',
  EXPLORE: 'INQUIRY',
  RESEARCH: 'INQUIRY',
  UNDERSTAND: 'INQUIRY',
  EASY: 'TRIVIAL',
  BASIC: 'SIMPLE',
  MINOR: 'SIMPLE',
  MODERATE: 'STANDARD',
  MEDIUM: 'STANDARD',
  NORMAL: 'STANDARD',
  HARD: 'STANDARD',
  COMPLEX: 'CRITICAL',
  RISKY: 'CRITICAL',
  HIGH_RISK: 'CRITICAL',
  DANGEROUS: 'CRITICAL',
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalize enum values in parsed JSON, mutating and returning the same value. */
function normalizeEnumValues(result: unknown, schema: EnumSchema | null | undefined): unknown {
  if (!isObjectRecord(result) || !schema?.properties) {
    return result;
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const matched = normalizeEnumValue({ result, key, propSchema });
    if (matched) {
      continue;
    }

    normalizeNestedValues(result, propSchema, key);
  }

  return result;
}

function normalizeEnumValue({ result, key, propSchema }: NormalizeEnumOptions): boolean {
  const rawValue = result[key];
  const enumValues = propSchema.enum;
  if (!enumValues || typeof rawValue !== 'string') {
    return false;
  }

  let value = rawValue.trim().toUpperCase();
  value = normalizeEnumCopyValue(value, enumValues, key, rawValue);

  const match = findEnumMatch(enumValues, value);
  if (match) {
    result[key] = match;
    return true;
  }

  const variation = ENUM_VARIATIONS[value];
  if (variation && enumValues.includes(variation)) {
    result[key] = variation;
  }

  return false;
}

function normalizeEnumCopyValue(
  value: string,
  enumValues: string[],
  key: string,
  rawValue: string
): string {
  if (!value.includes('|')) {
    return value;
  }

  const parts = value.split('|').map((part) => part.trim());
  const matchCount = parts.filter((part) => enumValues.includes(part)).length;
  if (matchCount < 2) {
    return value;
  }

  const firstValid = parts.find((part) => enumValues.includes(part));
  if (!firstValid) {
    return value;
  }

  console.warn(
    `⚠️  Model copied enum format instead of choosing. Field "${key}" had "${rawValue}", using "${firstValid}"`
  );
  return firstValid;
}

function findEnumMatch(enumValues: string[], value: string): string | undefined {
  return enumValues.find((entry) => entry.toUpperCase() === value);
}

function normalizeNestedValues(
  result: Record<string, unknown>,
  propSchema: EnumSchema,
  key: string
): void {
  const value = result[key];
  if (propSchema.type === 'object' && propSchema.properties && value) {
    normalizeEnumValues(value, propSchema);
  }

  const itemSchema = propSchema.items;
  if (propSchema.type === 'array' && itemSchema?.properties && Array.isArray(value)) {
    for (const item of value) {
      normalizeEnumValues(item, itemSchema);
    }
  }
}

export = {
  normalizeEnumValues,
};
