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

const { resolveDecisionPath, domainFor, isConsumedPath, CONSUMED_PATHS } = require('./setup-plan');
const { validateMountConfig, validateEnvPassthrough } = require('./docker-config');
const { VALID_PROVIDERS } = require('./provider-names');
const { VALID_MODELS, mapLegacyModelToLevel } = require('./settings');
const {
  loadJournal,
  saveJournal,
  upsertJournalEntry,
  getNestedValue,
  setNestedValue,
  deepEqual,
} = require('./setup-journal');

const SECRET_PATTERN = /token|secret|password|api[_-]?key|credential/i;

function assertSecretSafePath(targetPath) {
  if (SECRET_PATTERN.test(targetPath)) {
    throw new Error(`Refusing to write secret-shaped settings path: ${targetPath}`);
  }
}

function domainError(decisionId, value) {
  return new Error(
    `Invalid value for decision "${decisionId}": expected ${domainFor(decisionId)}, got ${JSON.stringify(value)}`
  );
}

// Resolve a submitted decision into the exact value stored at its canonical
// settings path, validating its decision domain before any write occurs.
function convertDecisionValue({ decisionId, value, globalSettings, deps }) {
  switch (decisionId) {
    case 'defaultProvider':
      if (typeof value !== 'string' || !deps.VALID_PROVIDERS.includes(value)) {
        throw domainError(decisionId, value);
      }
      return value;

    case 'defaultIsolation':
      if (!['worktree', 'docker', 'none'].includes(value)) throw domainError(decisionId, value);
      return value;

    case 'allowLocalNoIsolation':
      if (typeof value !== 'boolean') throw domainError(decisionId, value);
      return value;

    case 'defaultDelivery':
      if (!['none', 'pr', 'ship'].includes(value)) throw domainError(decisionId, value);
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
      if (!['off', 'notify', 'auto'].includes(value)) throw domainError(decisionId, value);
      return value;

    default:
      if (decisionId.startsWith('providerLevel.')) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw domainError(decisionId, value);
        }
        for (const key of ['min', 'default', 'max']) {
          if (!VALID_MODELS.includes(value[key])) throw domainError(decisionId, value);
        }
        const providerName = decisionId.slice('providerLevel.'.length);
        const existing = getNestedValue(globalSettings, `providerSettings.${providerName}`) || {};
        return {
          ...existing,
          minLevel: mapLegacyModelToLevel(value.min),
          defaultLevel: mapLegacyModelToLevel(value.default),
          maxLevel: mapLegacyModelToLevel(value.max),
        };
      }
      throw new Error(`Unknown decision ID: ${decisionId}`);
  }
}

function defaultApplyDeps() {
  const fs = require('fs');
  const { loadSettings, mutateSettings } = require('./settings');
  const { readRepoSettings, writeRepoSettings } = require('./repo-settings');
  const { checkGhAuth } = require('../src/preflight');
  const { listProviders: listIssueProviders } = require('../src/issue-providers');

  return {
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
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
function resolveAndValidateDecisions(input, globalSettings, deps) {
  const resolved = [];
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
  { decisionId, target, inputValue, writeValue },
  { globalSettings, repoSettings, allowRiskyDefaults }
) {
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
function applyWrite(write, { repoRoot, journal, deps }) {
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
  resolved,
  { repoSettings, repoRoot, journal, allowRiskyDefaults, deps }
) {
  const resultsById = new Map();
  let repoDirty = false;
  let globalDirty = false;
  const globalDecisions = resolved.filter((decision) => decision.target.scope === 'global');

  if (globalDecisions.length > 0) {
    const globalResults = deps.mutateSettings((freshGlobalSettings) => {
      const results = [];
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
  return resolved.map((decision) => resultsById.get(decision.decisionId));
}

/**
 * Apply a decisions file `{ "<decisionId>": <value>, ... }` to settings.
 *
 * @param {Object} params
 * @param {string} params.decisionsPath - Path to the decisions JSON file.
 * @param {string} params.cwd - Working directory (for repo-scope settings lookup).
 * @param {boolean} [params.allowRiskyDefaults] - Required to store defaultDelivery='ship'.
 * @param {Object} [params.deps] - Injected dependencies (for testing).
 * @returns {Array<{decisionId: string, applied: boolean, from: *, to: *, skippedReason?: string}>}
 */
function applyDecisions({ decisionsPath, cwd, allowRiskyDefaults = false, deps = {} }) {
  const resolvedDeps = { ...defaultApplyDeps(), ...deps };

  let input;
  try {
    input = JSON.parse(resolvedDeps.readFile(decisionsPath));
  } catch (err) {
    throw new Error(`Failed to read decisions file "${decisionsPath}": ${err.message}`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Decisions file must be a JSON object of { decisionId: value }');
  }

  const globalSettings = resolvedDeps.loadSettings();
  const { repoRoot, settings: repoSettingsRaw } = resolvedDeps.readRepoSettings(cwd);
  const repoSettings = repoSettingsRaw || {};

  const resolved = resolveAndValidateDecisions(input, globalSettings, resolvedDeps);

  const results = writeResolvedDecisions(resolved, {
    repoSettings,
    repoRoot,
    journal: loadJournal(),
    allowRiskyDefaults,
    deps: resolvedDeps,
  });

  // Never store provider-auth secrets: print the login command instead.
  const issueSourceApplied = results.find(
    (r) => r.decisionId === 'defaultIssueSource' && r.applied
  );
  if (issueSourceApplied && issueSourceApplied.to === 'github') {
    const auth = resolvedDeps.checkGhAuth();
    if (!auth || !auth.authenticated) {
      console.log('Run: gh auth login');
    }
  }

  return results;
}

module.exports = {
  applyDecisions,
  resolveAndValidateDecisions,
  writeResolvedDecisions,
  assertSecretSafePath,
  isConsumedPath,
  CONSUMED_PATHS,
};
