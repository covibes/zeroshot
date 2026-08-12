import repoSettingsAccess = require('./repo-settings-access');

type ProofStringField = 'scope' | 'description';

interface CommandProof {
  id: string;
  profile: string;
  command: string;
  scope?: string;
  description?: string;
}

interface CommandProofQualityGate {
  id: string;
  profile: string;
  command: string;
  commandProof: true;
  scope?: string;
  description?: string;
}

interface CommandProofOptions {
  cwd?: string;
  commandProofs?: unknown;
  ship?: unknown;
  [key: string]: unknown;
}

interface CommandProofConfig {
  commandProofs?: unknown;
  ship?: unknown;
  [key: string]: unknown;
}

const { propertyValue, readRepoSettingsValue, selectOwnProperty } = repoSettingsAccess;

const PROOF_BLOCK_PATTERN = /^```zeroshot-command-proofs\s*\n([\s\S]*?)^```/m;

function trimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function setOptionalString(
  target: CommandProof | CommandProofQualityGate,
  source: unknown,
  key: ProofStringField
): void {
  const value = trimString(propertyValue(source, key));
  if (value) {
    target[key] = value;
  }
}

function normalizeCommandProof(proof: unknown): CommandProof | null {
  if (!proof || typeof proof !== 'object') {
    return null;
  }

  const id = trimString(propertyValue(proof, 'id') || propertyValue(proof, 'name'));
  const profile = trimString(
    propertyValue(proof, 'profile') || propertyValue(proof, 'proofProfile')
  );
  const command = trimString(propertyValue(proof, 'command'));
  if (!id || !profile || !command) {
    return null;
  }

  const normalized: CommandProof = { id, profile, command };
  setOptionalString(normalized, proof, 'scope');
  setOptionalString(normalized, proof, 'description');
  return normalized;
}

function isCommandProof(proof: CommandProof | null): proof is CommandProof {
  return proof !== null;
}

function normalizeCommandProofs(value: unknown): CommandProof[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeCommandProof).filter(isCommandProof);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCommandProofsFromText(text: unknown): CommandProof[] {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }

  const match = PROOF_BLOCK_PATTERN.exec(text);
  const payload = match?.[1];
  if (payload === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Invalid zeroshot-command-proofs JSON: ${errorMessage(error)}`);
  }

  return normalizeCommandProofs(parsed);
}

function mergeCommandProofs(...sources: unknown[]): CommandProof[] {
  const byId = new Map<string, CommandProof>();
  const order: string[] = [];

  for (const source of sources) {
    for (const proof of normalizeCommandProofs(source)) {
      if (!byId.has(proof.id)) {
        order.push(proof.id);
      }
      byId.set(proof.id, proof);
    }
  }

  const merged: CommandProof[] = [];
  for (const id of order) {
    const proof = byId.get(id);
    if (proof) {
      merged.push(proof);
    }
  }
  return merged;
}

function commandProofToQualityGate(proof: unknown): CommandProofQualityGate | null {
  const normalized = normalizeCommandProof(proof);
  if (!normalized) {
    return null;
  }

  const gate: CommandProofQualityGate = {
    id: normalized.id,
    profile: normalized.profile,
    command: normalized.command,
    commandProof: true,
  };
  setOptionalString(gate, normalized, 'scope');
  setOptionalString(gate, normalized, 'description');
  return gate;
}

function getCommandProofSource(options: CommandProofOptions, repoSettings: unknown): unknown {
  const source = selectOwnProperty('commandProofs', [
    options,
    propertyValue(options, 'ship'),
    propertyValue(repoSettings, 'ship'),
    repoSettings,
  ]);
  return source === undefined ? [] : source;
}

function getClusterCommandProofSource(
  config: CommandProofConfig,
  options: CommandProofOptions
): unknown {
  return selectOwnProperty('commandProofs', [
    options,
    propertyValue(options, 'ship'),
    propertyValue(config, 'ship'),
    config,
  ]);
}

function resolveConfiguredCommandProofs(
  config: CommandProofConfig = {},
  options: CommandProofOptions = {}
): CommandProof[] {
  const configuredSource = getClusterCommandProofSource(config, options);
  if (configuredSource !== undefined) {
    return normalizeCommandProofs(configuredSource);
  }

  const repoSettings = readRepoSettingsValue(options.cwd || process.cwd());
  return normalizeCommandProofs(getCommandProofSource(options, repoSettings));
}

function resolveClusterCommandProofs(
  config: CommandProofConfig = {},
  options: CommandProofOptions = {},
  inputText: unknown = ''
): CommandProof[] {
  return mergeCommandProofs(
    resolveConfiguredCommandProofs(config, options),
    parseCommandProofsFromText(inputText)
  );
}

function isCommandProofQualityGate(
  gate: CommandProofQualityGate | null
): gate is CommandProofQualityGate {
  return gate !== null;
}

function commandProofsToQualityGates(commandProofs: unknown): CommandProofQualityGate[] {
  return normalizeCommandProofs(commandProofs)
    .map(commandProofToQualityGate)
    .filter(isCommandProofQualityGate);
}

export = {
  commandProofToQualityGate,
  commandProofsToQualityGates,
  mergeCommandProofs,
  normalizeCommandProofs,
  parseCommandProofsFromText,
  resolveClusterCommandProofs,
  resolveConfiguredCommandProofs,
};
