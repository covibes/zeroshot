type ModelLevel = 'level1' | 'level2' | 'level3';

interface ProviderLevelSettings extends Record<string, unknown> {
  defaultLevel?: ModelLevel;
  maxLevel?: ModelLevel;
  minLevel?: ModelLevel;
}

interface SettingsRecord extends Record<string, unknown> {
  maxModel?: string | null;
  minModel?: string | null;
  providerSettings?: Record<string, ProviderLevelSettings>;
}

const MODEL_HIERARCHY: Readonly<Record<string, number>> = Object.freeze({
  opus: 3,
  fable: 3,
  sonnet: 2,
  haiku: 1,
});

const VALID_MODELS = Object.keys(MODEL_HIERARCHY);
const LEVEL_RANKS: Readonly<Record<ModelLevel, number>> = Object.freeze({
  level1: 1,
  level2: 2,
  level3: 3,
});

function validateModelAgainstMax(
  requestedModel: string | null | undefined,
  maxModel: string,
  minModel: string | null = null
): string {
  if (!requestedModel) return maxModel;

  if (!VALID_MODELS.includes(requestedModel)) {
    throw new Error(`Invalid model "${requestedModel}". Valid: ${VALID_MODELS.join(', ')}`);
  }
  if (!VALID_MODELS.includes(maxModel)) {
    throw new Error(`Invalid maxModel "${maxModel}". Valid: ${VALID_MODELS.join(', ')}`);
  }

  const requestedRank = MODEL_HIERARCHY[requestedModel] ?? 0;
  const maximumRank = MODEL_HIERARCHY[maxModel] ?? 0;
  if (requestedRank > maximumRank) {
    throw new Error(
      `Agent requests "${requestedModel}" but maxModel is "${maxModel}". ` +
        `Either lower agent's model or raise maxModel.`
    );
  }

  if (minModel) {
    if (!VALID_MODELS.includes(minModel)) {
      throw new Error(`Invalid minModel "${minModel}". Valid: ${VALID_MODELS.join(', ')}`);
    }
    const minimumRank = MODEL_HIERARCHY[minModel] ?? 0;
    if (minimumRank > maximumRank) {
      throw new Error(`minModel "${minModel}" cannot be higher than maxModel "${maxModel}".`);
    }
    if (requestedRank < minimumRank) {
      throw new Error(
        `Agent requests "${requestedModel}" but minModel is "${minModel}". ` +
          `Either raise agent's model or lower minModel.`
      );
    }
  }

  return requestedModel;
}

function mapLegacyModelToLevel(model: unknown): ModelLevel | null {
  switch (model) {
    case 'haiku':
      return 'level1';
    case 'sonnet':
      return 'level2';
    case 'opus':
      return 'level3';
    default:
      return null;
  }
}

function levelRank(level: ModelLevel | undefined, fallback: ModelLevel): number {
  return LEVEL_RANKS[level ?? fallback];
}

function applyLegacyModelBounds(settings: SettingsRecord): SettingsRecord {
  if (!settings.providerSettings) return settings;
  const claude = settings.providerSettings.claude || {};
  const legacyMaxLevel = mapLegacyModelToLevel(settings.maxModel);
  const legacyMinLevel = mapLegacyModelToLevel(settings.minModel);

  if (legacyMaxLevel) {
    claude.maxLevel = legacyMaxLevel;
  }
  if (legacyMinLevel) {
    claude.minLevel = legacyMinLevel;
  }

  const minRank = levelRank(claude.minLevel, 'level1');
  const maxRank = levelRank(claude.maxLevel, 'level3');
  const defaultRank = levelRank(claude.defaultLevel, 'level2');

  if (minRank > maxRank) {
    claude.minLevel = 'level1';
    claude.maxLevel = 'level3';
  } else if (defaultRank < minRank && claude.minLevel !== undefined) {
    claude.defaultLevel = claude.minLevel;
  } else if (defaultRank > maxRank && claude.maxLevel !== undefined) {
    claude.defaultLevel = claude.maxLevel;
  }

  settings.providerSettings.claude = claude;
  return settings;
}

export = {
  MODEL_HIERARCHY,
  VALID_MODELS,
  validateModelAgainstMax,
  mapLegacyModelToLevel,
  applyLegacyModelBounds,
};
