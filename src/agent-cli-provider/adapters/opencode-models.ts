import { unknownToMessage } from '../json';
import {
  InvalidProviderModelError,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type ResolvedModelSpec,
} from '../types';
import { validateModelIdFromCatalog } from './common';

export const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  'opencode/big-pickle': { rank: 1 },
  'opencode/glm-4.7-free': { rank: 1 },
  'opencode/gpt-5-nano': { rank: 1 },
  'opencode/grok-code': { rank: 1 },
  'opencode/minimax-m2.1-free': { rank: 1 },
  'google/gemini-1.5-flash': { rank: 1 },
  'google/gemini-1.5-flash-8b': { rank: 1 },
  'google/gemini-1.5-pro': { rank: 1 },
  'google/gemini-2.0-flash': { rank: 1 },
  'google/gemini-2.0-flash-lite': { rank: 1 },
  'google/gemini-2.5-flash': { rank: 1 },
  'google/gemini-2.5-flash-image': { rank: 1 },
  'google/gemini-2.5-flash-image-preview': { rank: 1 },
  'google/gemini-2.5-flash-lite': { rank: 1 },
  'google/gemini-2.5-flash-lite-preview-06-17': { rank: 1 },
  'google/gemini-2.5-flash-lite-preview-09-2025': { rank: 1 },
  'google/gemini-2.5-flash-preview-04-17': { rank: 1 },
  'google/gemini-2.5-flash-preview-05-20': { rank: 1 },
  'google/gemini-2.5-flash-preview-09-2025': { rank: 1 },
  'google/gemini-2.5-flash-preview-tts': { rank: 1 },
  'google/gemini-2.5-pro': { rank: 1 },
  'google/gemini-2.5-pro-preview-05-06': { rank: 1 },
  'google/gemini-2.5-pro-preview-06-05': { rank: 1 },
  'google/gemini-2.5-pro-preview-tts': { rank: 1 },
  'google/gemini-3-flash-preview': { rank: 1 },
  'google/gemini-3-pro-preview': { rank: 1 },
  'google/gemini-embedding-001': { rank: 1 },
  'google/gemini-flash-latest': { rank: 1 },
  'google/gemini-flash-lite-latest': { rank: 1 },
  'google/gemini-live-2.5-flash': { rank: 1 },
  'google/gemini-live-2.5-flash-preview-native-audio': { rank: 1 },
  'openai/gpt-5.1-codex-max': { rank: 1 },
  'openai/gpt-5.1-codex-mini': { rank: 1 },
  'openai/gpt-5.2': { rank: 1 },
  'openai/gpt-5.2-codex': { rank: 1 },
};

export const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: null, reasoningEffort: 'low' },
  level2: { rank: 2, model: null, reasoningEffort: 'medium' },
  level3: { rank: 3, model: null, reasoningEffort: 'high' },
};

export function resolveModelSpec(
  level: ModelLevel,
  overrides?: LevelOverrides
): ResolvedModelSpec {
  const base = LEVEL_MAPPING[level] ?? LEVEL_MAPPING.level2;
  const override = overrides?.[level];
  const selectedModel = override?.model ?? base.model;
  return {
    level,
    model:
      override?.model === undefined || override.model === null
        ? (validateModelId(selectedModel) ?? null)
        : (validateConfiguredModelId(selectedModel) ?? null),
    reasoningEffort: override?.reasoningEffort ?? base.reasoningEffort,
  };
}

export function validateConfiguredModelId(
  modelId: string | null | undefined
): string | null | undefined {
  if (modelId && MODEL_CATALOG[modelId] !== undefined) return modelId;
  if (typeof modelId !== 'string') return validateModelId(modelId);
  const segments = modelId.split('/');
  if (segments.length >= 2 && segments.every(Boolean) && !/\s/u.test(modelId)) return modelId;
  throw new InvalidProviderModelError(
    `Invalid configured model "${unknownToMessage(
      modelId
    )}" for provider "opencode". Expected "provider/model" with no whitespace or empty path segments.`
  );
}

export function validateModelId(
  modelId: string | null | undefined
): string | null | undefined {
  return validateModelIdFromCatalog('opencode', MODEL_CATALOG, modelId);
}
