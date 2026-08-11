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

import setupJournal = require('./setup-journal');

type SettingsRecord = Record<string, unknown>;
type UndoStatus = 'already-restored' | 'skipped-modified' | 'deleted' | 'restored';

interface JournalEntry {
  readonly appliedAt: string;
  readonly appliedValue: unknown;
  readonly path: string;
  readonly priorValue: unknown;
  readonly repoRoot: string | null;
  readonly scope: string;
  readonly [key: string]: unknown;
}

interface SetupJournalFacade {
  deepEqual(left: unknown, right: unknown): boolean;
  deleteNestedKey(target: SettingsRecord, pathStr: string): void;
  getNestedValue(source: SettingsRecord, pathStr: string): unknown;
  loadJournal(): { entries: JournalEntry[] };
  setNestedValue(target: SettingsRecord, pathStr: string, value: unknown): void;
}

const {
  loadJournal,
  getNestedValue,
  setNestedValue,
  deleteNestedKey,
  deepEqual,
}: SetupJournalFacade = setupJournal;

interface UndoResult extends JournalEntry {
  current?: unknown;
  status: UndoStatus;
  wouldRestore?: unknown;
}

interface UndoDependencies {
  mutateSettings<T>(mutator: (settings: SettingsRecord) => T): T;
  readRepoSettings(repoRoot: string | null): { settings: SettingsRecord | null };
  writeRepoSettings(repoRoot: string | null, settings: SettingsRecord): unknown;
}

interface UndoParams {
  deps?: Partial<UndoDependencies>;
}

function defaultUndoDeps(): UndoDependencies {
  // These CommonJS paths intentionally resolve beside the emitted module in lib/.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { mutateSettings }: Pick<UndoDependencies, 'mutateSettings'> = require('./settings');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const {
    readRepoSettings,
    writeRepoSettings,
  }: Pick<UndoDependencies, 'readRepoSettings' | 'writeRepoSettings'> =
    require('./repo-settings');

  return { mutateSettings, readRepoSettings, writeRepoSettings };
}

/**
 * Undo every journaled write, per the three-way conflict rule.
 */
function undo({ deps = {} }: UndoParams = {}): Array<UndoResult | undefined> {
  const resolvedDeps: UndoDependencies = { ...defaultUndoDeps(), ...deps };
  const journal = loadJournal();

  const repoSettingsCache = new Map<string | null, SettingsRecord>();
  const dirtyRepoRoots = new Set<string | null>();

  function repoSettingsFor(repoRoot: string | null): SettingsRecord {
    const cachedSettings = repoSettingsCache.get(repoRoot);
    if (cachedSettings) {
      return cachedSettings;
    }
    const { settings } = resolvedDeps.readRepoSettings(repoRoot);
    const resolvedSettings = settings || {};
    repoSettingsCache.set(repoRoot, resolvedSettings);
    return resolvedSettings;
  }

  function restoreEntry(entry: JournalEntry, settingsObj: SettingsRecord): UndoResult {
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

  const resultsByIndex = new Map<number, UndoResult | undefined>();
  const globalEntries = journal.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.scope === 'global');

  if (globalEntries.length > 0) {
    const globalResults = resolvedDeps.mutateSettings((freshGlobalSettings) => {
      return globalEntries.map(({ entry }) => restoreEntry(entry, freshGlobalSettings));
    });
    globalEntries.forEach(({ index }, resultIndex) => {
      resultsByIndex.set(index, globalResults[resultIndex]);
    });
  }

  journal.entries.forEach((entry, index) => {
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

export = { undo };
