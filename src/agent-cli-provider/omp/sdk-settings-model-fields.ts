import { invalidField } from '../contract-errors';
import { isRecord } from '../json';
import {
  APIS,
  COMPAT_FIELDS,
  COMPAT_NUMBER_FIELDS,
  COMPAT_RECORD_FIELDS,
  COMPAT_STRING_ENUMS,
  COST_FIELDS,
  EFFORTS,
  INPUT_TYPES,
  MODEL_FIELDS,
  MODEL_OVERRIDE_FIELDS,
  MODEL_COMPONENT,
  THINKING_FIELDS,
  THINKING_MODES,
} from './sdk-settings-constants';
import type { OmpModelDefinition } from './sdk-settings-types';
import {
  booleanValue,
  emptyHeaders,
  enumValue,
  nonEmptyString,
  nonNegativeNumber,
  rejectUnknown,
  safeUrl,
} from './sdk-settings-values';

export function normalizeModelDefinition(value: unknown, field: string): OmpModelDefinition {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, MODEL_FIELDS, field);
  if (typeof value.id !== 'string' || value.id.length === 0 || !MODEL_COMPONENT.test(value.id)) {
    invalidField(`${field}.id`, 'Custom model id must be a non-empty string without whitespace.');
  }
  const result: { [field: string]: unknown; id: string } = { id: value.id };
  copyModelFields(value, result, field, true);
  return result;
}

export function normalizeModelOverride(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, MODEL_OVERRIDE_FIELDS, field);
  const result: Record<string, unknown> = {};
  copyModelFields(value, result, field, false);
  return result;
}

function copyModelFields(
  value: Record<string, unknown>,
  result: Record<string, unknown>,
  field: string,
  allowApiAndBaseUrl: boolean
): void {
  if (value.name !== undefined) result.name = nonEmptyString(value.name, `${field}.name`);
  if (allowApiAndBaseUrl && value.api !== undefined) {
    result.api = enumValue(value.api, APIS, `${field}.api`);
  }
  if (allowApiAndBaseUrl && value.baseUrl !== undefined) {
    result.baseUrl = safeUrl(value.baseUrl, `${field}.baseUrl`);
  }
  for (const key of ['reasoning', 'supportsTools', 'omitMaxOutputTokens'] as const) {
    if (value[key] !== undefined) result[key] = booleanValue(value[key], `${field}.${key}`);
  }
  for (const key of ['premiumMultiplier', 'contextWindow', 'maxTokens'] as const) {
    if (value[key] !== undefined) {
      result[key] = nonNegativeNumber(value[key], `${field}.${key}`);
    }
  }
  for (const key of ['contextPromotionTarget', 'compactionModel'] as const) {
    if (value[key] !== undefined) result[key] = nonEmptyString(value[key], `${field}.${key}`);
  }
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.length === 0) {
      invalidField(`${field}.input`, 'input must be a non-empty text/image array.');
    }
    result.input = value.input.map((item, index) =>
      enumValue(item, INPUT_TYPES, `${field}.input[${index}]`)
    );
  }
  if (value.thinking !== undefined) {
    result.thinking = normalizeThinking(value.thinking, `${field}.thinking`);
  }
  if (value.cost !== undefined) {
    result.cost = normalizeCost(value.cost, `${field}.cost`, allowApiAndBaseUrl);
  }
  if (value.headers !== undefined) result.headers = emptyHeaders(value.headers, `${field}.headers`);
  if (value.compat !== undefined) result.compat = normalizeCompat(value.compat, `${field}.compat`);
  if (value.remoteCompaction !== undefined) {
    invalidField(`${field}.remoteCompaction`, 'Remote compaction config is not accepted.');
  }
}

function normalizeThinking(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, THINKING_FIELDS, field);
  const result: Record<string, unknown> = {
    mode: enumValue(value.mode, THINKING_MODES, `${field}.mode`),
  };
  for (const key of ['efforts', 'levels'] as const) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length === 0) {
        invalidField(`${field}.${key}`, `${key} must be a non-empty effort array.`);
      }
      result[key] = value[key].map((item, index) =>
        enumValue(item, EFFORTS, `${field}.${key}[${index}]`)
      );
    }
  }
  for (const key of ['defaultLevel', 'minLevel', 'maxLevel'] as const) {
    if (value[key] !== undefined) {
      result[key] = enumValue(value[key], EFFORTS, `${field}.${key}`);
    }
  }
  if (value.supportsDisplay !== undefined) {
    result.supportsDisplay = booleanValue(value.supportsDisplay, `${field}.supportsDisplay`);
  }
  if (value.effortMap !== undefined) {
    result.effortMap = normalizeEffortMap(value.effortMap, `${field}.effortMap`);
  }
  const hasEfforts = result.efforts !== undefined || result.levels !== undefined;
  if (!hasEfforts && (result.minLevel === undefined || result.maxLevel === undefined)) {
    invalidField(field, 'thinking requires efforts, levels, or both minLevel and maxLevel.');
  }
  return result;
}

function normalizeEffortMap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, new Set(EFFORTS), field);
  const result: Record<string, string> = {};
  for (const [effort, mapped] of Object.entries(value)) {
    result[effort] = nonEmptyString(mapped, `${field}.${effort}`);
  }
  return result;
}

function normalizeCost(
  value: unknown,
  field: string,
  requireAllFields: boolean
): Record<string, number> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, COST_FIELDS, field);
  if (requireAllFields) {
    const missing = [...COST_FIELDS].find((key) => value[key] === undefined);
    if (missing !== undefined) {
      invalidField(`${field}.${missing}`, `${field}.${missing} is required.`);
    }
  }
  const result: Record<string, number> = {};
  for (const key of COST_FIELDS) {
    if (value[key] !== undefined) {
      result[key] = nonNegativeNumber(value[key], `${field}.${key}`);
    }
  }
  return result;
}

export function normalizeCompat(
  value: unknown,
  field: string,
  allowWhenThinking = true
): Record<string, unknown> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, COMPAT_FIELDS, field);
  if (Object.prototype.hasOwnProperty.call(value, 'extraBody')) {
    invalidField(
      `${field}.extraBody`,
      'Arbitrary request bodies may contain persisted secrets and are not accepted.'
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'whenThinking') {
      if (!allowWhenThinking) {
        invalidField(
          `${field}.whenThinking`,
          'Nested compat.whenThinking is not a native OMP field.'
        );
      }
      result[key] = normalizeCompat(item, `${field}.whenThinking`, false);
      continue;
    }
    if (COMPAT_RECORD_FIELDS.has(key)) {
      result[key] =
        key === 'reasoningEffortMap'
          ? normalizeEffortMap(item, `${field}.${key}`)
          : normalizeRouting(item, `${field}.${key}`);
      continue;
    }
    if (COMPAT_NUMBER_FIELDS.has(key)) {
      result[key] = nonNegativeNumber(item, `${field}.${key}`);
      continue;
    }
    if (key === 'maxTokensField') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.maxTokensField, `${field}.${key}`);
      continue;
    }
    if (key === 'reasoningContentField') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.reasoningContentField, `${field}.${key}`);
      continue;
    }
    if (key === 'thinkingFormat') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.thinkingFormat, `${field}.${key}`);
      continue;
    }
    if (key === 'cacheControlFormat') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.cacheControlFormat, `${field}.${key}`);
      continue;
    }
    if (key === 'toolStrictMode') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.toolStrictMode, `${field}.${key}`);
      continue;
    }
    if (key === 'promptCacheMode') {
      result[key] = enumValue(item, COMPAT_STRING_ENUMS.promptCacheMode, `${field}.${key}`);
      continue;
    }
    result[key] = booleanValue(item, `${field}.${key}`);
  }
  return result;
}

function normalizeRouting(value: unknown, field: string): Record<string, readonly string[]> {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, new Set(['only', 'order']), field);
  const result: Record<string, readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item)) invalidField(`${field}.${key}`, `${field}.${key} must be an array.`);
    result[key] = item.map((entry, index) => nonEmptyString(entry, `${field}.${key}[${index}]`));
  }
  return result;
}
