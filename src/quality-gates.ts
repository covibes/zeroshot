import repoSettingsAccess = require('./repo-settings-access');

type StringGateField = 'scope' | 'description' | 'command' | 'profile' | 'proofProfile';

interface RequiredQualityGate {
  id: string;
  scope?: string;
  description?: string;
  command?: string;
  profile?: string;
  proofProfile?: string;
  commandProof?: true;
}

interface QualityGateOptions {
  cwd?: string;
  requiredQualityGates?: unknown;
  ship?: unknown;
  [key: string]: unknown;
}

interface QualityGateConfig {
  requiredQualityGates?: unknown;
  ship?: unknown;
  [key: string]: unknown;
}

const { isRecord, propertyValue, readRepoSettingsValue, selectOwnProperty } = repoSettingsAccess;

function getGateId(gate: Record<string, unknown>): string | null {
  if (typeof gate.id === 'string' && gate.id.trim()) {
    return gate.id.trim();
  }

  if (typeof gate.name === 'string' && gate.name.trim()) {
    return gate.name.trim();
  }

  return null;
}

function normalizeStringGate(gate: string): RequiredQualityGate | null {
  const id = gate.trim();
  return id ? { id } : null;
}

function setOptionalString(
  target: RequiredQualityGate,
  source: Record<string, unknown>,
  key: StringGateField
): void {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) {
    target[key] = value.trim();
  }
}

function normalizeObjectGate(gate: unknown): RequiredQualityGate | null {
  if (!isRecord(gate)) {
    return null;
  }

  const id = getGateId(gate);
  if (!id) {
    return null;
  }

  const normalized: RequiredQualityGate = { id };
  setOptionalString(normalized, gate, 'scope');
  setOptionalString(normalized, gate, 'description');
  setOptionalString(normalized, gate, 'command');
  setOptionalString(normalized, gate, 'profile');
  setOptionalString(normalized, gate, 'proofProfile');
  if (gate.commandProof === true) {
    normalized.commandProof = true;
  }
  return normalized;
}

function isRequiredQualityGate(gate: RequiredQualityGate | null): gate is RequiredQualityGate {
  return gate !== null;
}

function normalizeRequiredQualityGates(value: unknown): RequiredQualityGate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((gate) => {
      if (typeof gate === 'string') {
        return normalizeStringGate(gate);
      }
      return normalizeObjectGate(gate);
    })
    .filter(isRequiredQualityGate);
}

function getRequiredQualityGateSource(options: QualityGateOptions, repoSettings: unknown): unknown {
  const explicitSource = selectOwnProperty(
    'requiredQualityGates',
    [options, propertyValue(options, 'ship')],
    { skipUndefined: true }
  );
  if (explicitSource !== undefined) {
    return explicitSource;
  }

  const repoSource = selectOwnProperty('requiredQualityGates', [
    propertyValue(repoSettings, 'ship'),
    repoSettings,
  ]);
  return repoSource === undefined ? [] : repoSource;
}

function resolveRequiredQualityGates(options: QualityGateOptions = {}): RequiredQualityGate[] {
  const repoSettings = readRepoSettingsValue(options.cwd || process.cwd());
  const source = getRequiredQualityGateSource(options, repoSettings);
  return normalizeRequiredQualityGates(source);
}

function getClusterRequiredQualityGateSource(
  config: QualityGateConfig,
  options: QualityGateOptions
): unknown {
  return selectOwnProperty(
    'requiredQualityGates',
    [options, propertyValue(options, 'ship'), propertyValue(config, 'ship'), config],
    { skipUndefined: true }
  );
}

function resolveClusterRequiredQualityGates(
  config: QualityGateConfig = {},
  options: QualityGateOptions = {}
): RequiredQualityGate[] {
  const configuredSource = getClusterRequiredQualityGateSource(config, options);
  if (configuredSource !== undefined) {
    return normalizeRequiredQualityGates(configuredSource);
  }

  return resolveRequiredQualityGates({ ...options, cwd: options.cwd || process.cwd() });
}

export = {
  normalizeRequiredQualityGates,
  resolveRequiredQualityGates,
  resolveClusterRequiredQualityGates,
};
