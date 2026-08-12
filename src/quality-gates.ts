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

interface RepoSettingsResult {
  settings?: unknown;
}

interface RepoSettingsModule {
  readRepoSettings(startDir: string): RepoSettingsResult;
}

function isRepoSettingsModule(value: unknown): value is RepoSettingsModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readRepoSettings' in value &&
    typeof value.readRepoSettings === 'function'
  );
}

const repoSettingsModule: unknown = require('../lib/repo-settings');
if (!isRepoSettingsModule(repoSettingsModule)) {
  throw new TypeError('repo-settings must export readRepoSettings');
}
const readRepoSettings = repoSettingsModule.readRepoSettings;

function hasOwn(value: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function propertyValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function hasDefinedOwn(value: unknown, key: string): boolean {
  return hasOwn(value, key) && propertyValue(value, key) !== undefined;
}

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
  if (hasDefinedOwn(options, 'requiredQualityGates')) {
    return options.requiredQualityGates;
  }

  if (isRecord(options.ship) && hasDefinedOwn(options.ship, 'requiredQualityGates')) {
    return options.ship.requiredQualityGates;
  }

  const settingsShip = propertyValue(repoSettings, 'ship');
  if (isRecord(settingsShip) && hasOwn(settingsShip, 'requiredQualityGates')) {
    return settingsShip.requiredQualityGates;
  }

  if (hasOwn(repoSettings, 'requiredQualityGates')) {
    return propertyValue(repoSettings, 'requiredQualityGates');
  }

  return [];
}

function resolveRequiredQualityGates(options: QualityGateOptions = {}): RequiredQualityGate[] {
  const repoSettingsResult = readRepoSettings(options.cwd || process.cwd());
  const repoSettings = repoSettingsResult.settings || {};
  const source = getRequiredQualityGateSource(options, repoSettings);
  return normalizeRequiredQualityGates(source);
}

function getClusterRequiredQualityGateSource(
  config: QualityGateConfig,
  options: QualityGateOptions
): unknown {
  if (hasDefinedOwn(options, 'requiredQualityGates')) {
    return options.requiredQualityGates;
  }

  if (isRecord(options.ship) && hasDefinedOwn(options.ship, 'requiredQualityGates')) {
    return options.ship.requiredQualityGates;
  }

  if (isRecord(config.ship) && hasDefinedOwn(config.ship, 'requiredQualityGates')) {
    return config.ship.requiredQualityGates;
  }

  if (hasDefinedOwn(config, 'requiredQualityGates')) {
    return config.requiredQualityGates;
  }

  return undefined;
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
