/**
 * `zeroshot setup apply` — writes decisions from #A's plan/decision contract
 * (lib/setup-plan.js) to global settings, repo-local settings, and the undo
 * journal (lib/setup-journal.js).
 *
 * Fail-closed: every input decisionId + value is resolved and validated
 * against its domain before ANY write happens. Writes are then applied only
 * to settings keys a run-mode resolver actually reads (setup-plan.js's
 * CONSUMED_PATHS/isConsumedPath — the same set that filters proposedWrites)
 * — a settings key nobody reads is dead config, the exact drift the
 * canonical-path rule (issue #605) forbids.
 */

import type {
  ApplyDecisionValuesParams,
  ApplyDecisionsParams,
  ApplyDependencies,
  DecisionResult,
  PendingWrite,
  ResolvedDecision,
  SettingsMap,
  SetupJournal,
} from './setup-apply-types';

interface SetupPlanFacade {
  CONSUMED_PATHS: Set<string>;
  domainFor(decisionId: string): string;
  isConsumedPath(scope: string, targetPath: string): boolean;
  resolveDecisionPath(decisionId: string): { path: string; scope: 'global' | 'repo' } | null;
}

interface DockerConfigFacade {
  validateEnvPassthrough(value: unknown): string | null;
  validateMountConfig(value: unknown): string | null;
}

interface ProviderNamesFacade {
  VALID_PROVIDERS: readonly string[];
}

interface FileSystemFacade {
  readFileSync(filePath: string, encoding: 'utf8'): string;
}

interface SetupJournalFacade {
  deepEqual(left: unknown, right: unknown): boolean;
  getNestedValue(source: unknown, pathStr: string): unknown;
  loadJournal(): SetupJournal;
  saveJournal(journal: SetupJournal): void;
  setNestedValue(target: SettingsMap, pathStr: string, value: unknown): void;
  upsertJournalEntry(journal: SetupJournal, entry: SetupJournal['entries'][number]): void;
}

interface ConvertDecisionParams {
  decisionId: string;
  deps: ApplyDependencies;
  globalSettings: SettingsMap;
  value: unknown;
}

interface ResolveDecisionContext {
  allowRiskyDefaults: boolean;
  globalSettings: SettingsMap;
  repoSettings: SettingsMap;
}

interface ApplyWriteContext {
  deps: ApplyDependencies;
  journal: SetupJournal;
  repoRoot: string | null;
}

interface WriteResolvedContext extends ApplyWriteContext {
  allowRiskyDefaults: boolean;
  repoSettings: SettingsMap;
}

// These CommonJS paths intentionally resolve beside the emitted module in lib/.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { resolveDecisionPath, domainFor, isConsumedPath, CONSUMED_PATHS }: SetupPlanFacade =
  require('./setup-plan');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { validateMountConfig, validateEnvPassthrough }: DockerConfigFacade =
  require('./docker-config');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { VALID_PROVIDERS }: ProviderNamesFacade = require('./provider-names');
const VALID_LEVELS = Object.freeze(['level1', 'level2', 'level3']);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const setupJournal: SetupJournalFacade = require('./setup-journal');
const { loadJournal, saveJournal, upsertJournalEntry } = setupJournal;
const { getNestedValue, setNestedValue, deepEqual } = setupJournal;

const SECRET_PATTERN = /token|secret|password|api[_-]?key|credential/i;

function includesValue(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

function assertSecretSafePath(targetPath: string): void {
  if (SECRET_PATTERN.test(targetPath)) {
    throw new Error(`Refusing to write secret-shaped settings path: ${targetPath}`);
  }
}

function domainError(decisionId: string, value: unknown): Error {
  const expected = domainFor(decisionId);
  const received = JSON.stringify(value);
  return new Error(
    `Invalid value for decision "${decisionId}": expected ${expected}, got ${received}`
  );
}

function convertProviderLevelDecision({
  decisionId,
  value,
  globalSettings,
  deps,
}: ConvertDecisionParams): SettingsMap {
  if (!decisionId.startsWith('providerLevel.')) {
    throw new Error(`Unknown decision ID: ${decisionId}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw domainError(decisionId, value);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const decisionValue = value as SettingsMap;
  // Preserve Array.prototype.sort's default UTF-16 ordering.
  // eslint-disable-next-line sonarjs/no-alphabetical-sort
  const keys = Object.keys(decisionValue).sort();
  const expectedKeys = ['defaultLevel', 'maxLevel', 'minLevel'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => !includesValue(VALID_LEVELS, decisionValue[key]))
  ) {
    throw domainError(decisionId, value);
  }
  const providerName = decisionId.slice('providerLevel.'.length);
  if (!deps.VALID_PROVIDERS.includes(providerName)) throw domainError(decisionId, value);
  const rank = (level: unknown): number => VALID_LEVELS.findIndex((item) => item === level);
  if (
    rank(decisionValue.minLevel) > rank(decisionValue.defaultLevel) ||
    rank(decisionValue.defaultLevel) > rank(decisionValue.maxLevel)
  ) {
    throw domainError(decisionId, value);
  }
  const existingValue = getNestedValue(globalSettings, `providerSettings.${providerName}`) || {};
  // Both operands have passed the same object-domain checks used by the legacy implementation.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const existing = existingValue as SettingsMap;
  return { ...existing, ...decisionValue };
}

// Resolve a submitted decision into the exact value stored at its canonical
// settings path, validating its decision domain before any write occurs.
function convertDecisionValue({
  decisionId,
  value,
  globalSettings,
  deps,
}: ConvertDecisionParams): unknown {
  switch (decisionId) {
    case 'defaultProvider':
      if (typeof value !== 'string' || !deps.VALID_PROVIDERS.includes(value)) {
        throw domainError(decisionId, value);
      }
      return value;

    case 'defaultIsolation':
      if (!includesValue(['worktree', 'docker', 'none'], value)) {
        throw domainError(decisionId, value);
      }
      return value;

    case 'allowLocalNoIsolation':
      if (typeof value !== 'boolean') throw domainError(decisionId, value);
      return value;

    case 'defaultDelivery':
      if (!includesValue(['none', 'pr', 'ship'], value)) throw domainError(decisionId, value);
      return value;

    case 'defaultIssueSource':
      if (typeof value !== 'string' || !deps.listIssueProviders().includes(value)) {
        throw domainError(decisionId, value);
      }
      return value;

    case 'prBase':
      if (typeof value !== 'string' || value.trim() === '') throw domainError(decisionId, value);
      return value;

    case 'dockerMounts': {
      const err = validateMountConfig(value);
      if (err) throw new Error(`Invalid value for decision "${decisionId}": ${err}`);
      return value;
    }

    case 'dockerEnvPassthrough': {
      const err = validateEnvPassthrough(value);
      if (err) throw new Error(`Invalid value for decision "${decisionId}": ${err}`);
      return value;
    }

    case 'updatePolicy':
      if (!includesValue(['off', 'notify', 'auto'], value)) throw domainError(decisionId, value);
      return value;

    default:
      return convertProviderLevelDecision({ decisionId, value, globalSettings, deps });
  }
}

function defaultApplyDeps(): ApplyDependencies {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const fs: FileSystemFacade = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { loadSettings, mutateSettings }: Pick<
    ApplyDependencies,
    'loadSettings' | 'mutateSettings'
  > = require('./settings');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { readRepoSettings, writeRepoSettings }: Pick<
    ApplyDependencies,
    'readRepoSettings' | 'writeRepoSettings'
  > = require('./repo-settings');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { checkGhAuth }: Pick<ApplyDependencies, 'checkGhAuth'> = require('../src/preflight');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { listProviders: listIssueProviders }: {
    listProviders: ApplyDependencies['listIssueProviders'];
  } = require('../src/issue-providers');

  return {
    readFile: (filePath: string) => fs.readFileSync(filePath, 'utf8'),
    loadSettings,
    mutateSettings,
    readRepoSettings,
    writeRepoSettings,
    checkGhAuth,
    listIssueProviders,
    VALID_PROVIDERS,
    now: () => new Date().toISOString(),
  };
}

// Phase 1: resolve + validate EVERY input decision before any write happens
// (fail-closed — a single bad decisionId or out-of-domain value rejects the
// whole request, never a partial apply).
function resolveAndValidateDecisions(
  input: SettingsMap,
  globalSettings: SettingsMap,
  deps: ApplyDependencies
): ResolvedDecision[] {
  const resolved: ResolvedDecision[] = [];
  for (const [decisionId, value] of Object.entries(input)) {
    const target = resolveDecisionPath(decisionId);
    if (!target) {
      throw new Error(`Unknown decision ID: ${decisionId}`);
    }
    assertSecretSafePath(target.path);
    const writeValue = convertDecisionValue({ decisionId, value, globalSettings, deps });
    resolved.push({ decisionId, target, inputValue: value, writeValue });
  }
  return resolved;
}

// Decides the outcome for a single resolved decision: a skip (with reason)
// or the write to perform. Returns the write descriptor rather than mutating
// anything, so the caller controls when settings objects/journal are touched.
function resolveDecisionOutcome(
  decision: ResolvedDecision,
  context: ResolveDecisionContext
): { result: DecisionResult; write?: PendingWrite } {
  const { decisionId, target, inputValue, writeValue } = decision;
  const { globalSettings, repoSettings, allowRiskyDefaults } = context;
  const settingsObj = target.scope === 'repo' ? repoSettings : globalSettings;
  const currentValue = getNestedValue(settingsObj, target.path) ?? null;
  const base = { decisionId, from: currentValue, to: writeValue };

  if (decisionId === 'defaultDelivery' && inputValue === 'ship' && !allowRiskyDefaults) {
    return { result: { ...base, applied: false, skippedReason: 'requires-explicit-opt-in' } };
  }
  if (!isConsumedPath(target.scope, target.path)) {
    return { result: { ...base, applied: false, skippedReason: 'no-consumer' } };
  }
  if (deepEqual(currentValue, writeValue)) {
    return { result: { ...base, applied: false, skippedReason: 'unchanged' } };
  }

  return {
    result: { ...base, applied: true },
    write: {
      settingsObj,
      scope: target.scope,
      path: target.path,
      writeValue,
      priorValue: currentValue,
    },
  };
}

// Applies one decision's write to its in-memory settings object and journals
// it (deferred persistence — the caller flushes to disk once at the end).
function applyWrite(
  write: PendingWrite,
  context: ApplyWriteContext
): 'global' | 'repo' {
  const { repoRoot, journal, deps } = context;
  setNestedValue(write.settingsObj, write.path, write.writeValue);
  upsertJournalEntry(journal, {
    scope: write.scope,
    path: write.path,
    repoRoot: write.scope === 'repo' ? repoRoot : null,
    priorValue: write.priorValue,
    appliedValue: write.writeValue,
    appliedAt: deps.now(),
  });
  return write.scope;
}

// Phase 2: resolve each global outcome against the locked, freshly read state.
// Repo-local settings remain intentionally outside the global settings lock.
function writeResolvedDecisions(
  resolved: ResolvedDecision[],
  context: WriteResolvedContext
): DecisionResult[] {
  const { repoSettings, repoRoot, journal, allowRiskyDefaults, deps } = context;
  const resultsById = new Map<string, DecisionResult>();
  let repoDirty = false;
  let globalDirty = false;
  const globalDecisions = resolved.filter((decision) => decision.target.scope === 'global');

  if (globalDecisions.length > 0) {
    const globalResults = deps.mutateSettings((freshGlobalSettings) => {
      const results: DecisionResult[] = [];
      for (const decision of globalDecisions) {
        const freshDecision = {
          ...decision,
          writeValue: convertDecisionValue({
            decisionId: decision.decisionId,
            value: decision.inputValue,
            globalSettings: freshGlobalSettings,
            deps,
          }),
        };
        const { result, write } = resolveDecisionOutcome(freshDecision, {
          globalSettings: freshGlobalSettings,
          repoSettings,
          allowRiskyDefaults,
        });
        results.push(result);
        if (write) {
          applyWrite(write, { repoRoot, journal, deps });
          globalDirty = true;
        }
      }
      return results;
    });
    for (const result of globalResults) resultsById.set(result.decisionId, result);
  }

  for (const decision of resolved.filter((item) => item.target.scope === 'repo')) {
    const { result, write } = resolveDecisionOutcome(decision, {
      globalSettings: {},
      repoSettings,
      allowRiskyDefaults,
    });
    resultsById.set(result.decisionId, result);
    if (!write) continue;
    applyWrite(write, { repoRoot, journal, deps });
    repoDirty = true;
  }

  if (repoDirty) deps.writeRepoSettings(repoRoot, repoSettings);
  if (globalDirty || repoDirty) saveJournal(journal);
  return resolved.map((decision) => {
    const result = resultsById.get(decision.decisionId);
    if (!result) throw new Error(`Missing apply result for decision: ${decision.decisionId}`);
    return result;
  });
}

function assertDecisionObject(decisions: unknown, label: string): asserts decisions is SettingsMap {
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new Error(`${label} must be a JSON object of { decisionId: value }`);
  }
}

/** Apply an in-memory decision object without temporary files. */
function applyDecisionValues({
  decisions,
  cwd,
  allowRiskyDefaults = false,
  deps = {},
}: ApplyDecisionValuesParams): DecisionResult[] {
  assertDecisionObject(decisions, 'Decisions');
  const resolvedDeps: ApplyDependencies = { ...defaultApplyDeps(), ...deps };
  const globalSettings = resolvedDeps.loadSettings();
  const { repoRoot, settings: repoSettingsRaw } = resolvedDeps.readRepoSettings(cwd);
  const repoSettings = repoSettingsRaw || {};
  const resolved = resolveAndValidateDecisions(decisions, globalSettings, resolvedDeps);
  const results = writeResolvedDecisions(resolved, {
    repoSettings,
    repoRoot,
    journal: loadJournal(),
    allowRiskyDefaults,
    deps: resolvedDeps,
  });

  const issueSourceApplied = results.find(
    (result) => result.decisionId === 'defaultIssueSource' && result.applied
  );
  if (issueSourceApplied?.to === 'github') {
    const auth = resolvedDeps.checkGhAuth();
    if (!auth?.authenticated) console.log('Run: gh auth login');
  }
  return results;
}

/** Apply a decisions JSON file through the shared object API. */
function applyDecisions({
  decisionsPath,
  cwd,
  allowRiskyDefaults = false,
  deps = {},
}: ApplyDecisionsParams): DecisionResult[] {
  const resolvedDeps: ApplyDependencies = { ...defaultApplyDeps(), ...deps };
  let decisions: unknown;
  try {
    decisions = JSON.parse(resolvedDeps.readFile(decisionsPath));
  } catch (error) {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? error.message
        : undefined;
    throw new Error(`Failed to read decisions file "${decisionsPath}": ${String(message)}`);
  }
  assertDecisionObject(decisions, 'Decisions file');
  return applyDecisionValues({
    decisions,
    cwd,
    allowRiskyDefaults,
    deps: resolvedDeps,
  });
}

export = {
  applyDecisions,
  applyDecisionValues,
  resolveAndValidateDecisions,
  writeResolvedDecisions,
  assertSecretSafePath,
  isConsumedPath,
  CONSUMED_PATHS,
};
