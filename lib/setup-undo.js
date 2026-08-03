/**
 * `zeroshot setup undo` — reverts writes made by `zeroshot setup apply` using
 * the journal recorded at apply time (lib/setup-journal.js).
 *
 * Three-way conflict rule per journaled write, comparing `current` against
 * `appliedValue`:
 *   - current === appliedValue      -> restore priorValue (delete if null)
 *   - current === priorValue        -> already-restored (no-op)
 *   - otherwise (changed elsewhere) -> skipped-modified, never clobbered
 */

const {
  loadJournal,
  getNestedValue,
  setNestedValue,
  deleteNestedKey,
  deepEqual,
} = require('./setup-journal');

function defaultUndoDeps() {
  const { mutateSettings } = require('./settings');
  const { readRepoSettings, writeRepoSettings } = require('./repo-settings');

  return { mutateSettings, readRepoSettings, writeRepoSettings };
}

function isManualProviderPath(targetPath) {
  return targetPath === 'defaultProvider' || targetPath.startsWith('providerSettings.');
}

/**
 * Undo every journaled write, per the three-way conflict rule.
 *
 * @param {Object} [params]
 * @param {Object} [params.deps] - Injected dependencies (for testing).
 * @returns {Array<{scope: string, path: string, repoRoot: string|null, status: string, current?: *, wouldRestore?: *}>}
 */
function undo({ deps = {} } = {}) {
  const resolvedDeps = { ...defaultUndoDeps(), ...deps };
  const journal = loadJournal();

  const repoSettingsCache = new Map();
  const dirtyRepoRoots = new Set();

  function repoSettingsFor(repoRoot) {
    if (!repoSettingsCache.has(repoRoot)) {
      const { settings } = resolvedDeps.readRepoSettings(repoRoot);
      repoSettingsCache.set(repoRoot, settings || {});
    }
    return repoSettingsCache.get(repoRoot);
  }

  function restoreEntry(entry, settingsObj) {
    const current = getNestedValue(settingsObj, entry.path) ?? null;
    if (deepEqual(current, entry.priorValue)) {
      return { ...entry, status: 'already-restored' };
    }
    if (!deepEqual(current, entry.appliedValue)) {
      return { ...entry, status: 'skipped-modified', current, wouldRestore: entry.priorValue };
    }
    if (entry.priorValue === null) {
      deleteNestedKey(settingsObj, entry.path);
    } else {
      setNestedValue(settingsObj, entry.path, entry.priorValue);
    }
    return { ...entry, status: entry.priorValue === null ? 'deleted' : 'restored' };
  }

  const resultsByIndex = new Map();
  journal.entries.forEach((entry, index) => {
    if (isManualProviderPath(entry.path)) {
      resultsByIndex.set(index, {
        scope: entry.scope,
        path: entry.path,
        status: 'skipped-manual-provider-configuration',
      });
    }
  });
  const globalEntries = journal.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.scope === 'global' && !isManualProviderPath(entry.path));

  if (globalEntries.length > 0) {
    const globalResults = resolvedDeps.mutateSettings((freshGlobalSettings) =>
      globalEntries.map(({ entry }) => restoreEntry(entry, freshGlobalSettings))
    );
    globalEntries.forEach(({ index }, resultIndex) => {
      resultsByIndex.set(index, globalResults[resultIndex]);
    });
  }

  journal.entries.forEach((entry, index) => {
    if (isManualProviderPath(entry.path)) return;
    if (entry.scope !== 'repo') return;
    const result = restoreEntry(entry, repoSettingsFor(entry.repoRoot));
    resultsByIndex.set(index, result);
    if (result.status === 'restored' || result.status === 'deleted') {
      dirtyRepoRoots.add(entry.repoRoot);
    }
  });

  for (const repoRoot of dirtyRepoRoots) {
    resolvedDeps.writeRepoSettings(repoRoot, repoSettingsFor(repoRoot));
  }

  // Journal entries are left in place (not cleared) so a re-run reports
  // 'already-restored' instead of finding nothing to undo.
  return journal.entries.map((_, index) => resultsByIndex.get(index));
}

module.exports = { undo };
