/**
 * Undo journal for `zeroshot setup apply` / `zeroshot setup undo`.
 *
 * One journal entry per setting this setup owns: { scope, path, repoRoot,
 * priorValue, appliedValue, appliedAt }. `priorValue: null` means the key
 * did not exist before apply, so undo deletes it rather than restoring it.
 * Shared by lib/setup-apply.js (writer) and lib/setup-undo.js (reader) so the
 * nested-path mutation and equality semantics can't drift between the two.
 */

import fs = require('fs');
import path = require('path');

interface SettingsFacade {
  getSettingsFile(): string;
}

interface SetupPlanFacade {
  getNestedValue(source: Record<string, unknown>, pathStr: string): unknown;
}

interface JournalEntry {
  readonly appliedAt: string;
  readonly appliedValue: unknown;
  readonly path: string;
  readonly priorValue: unknown;
  readonly repoRoot: string | null;
  readonly scope: string;
  readonly [key: string]: unknown;
}

interface SetupJournal {
  entries: JournalEntry[];
  version: number;
  [key: string]: unknown;
}

// These CommonJS paths intentionally resolve beside the emitted module in lib/.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { getSettingsFile }: SettingsFacade = require('./settings');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { getNestedValue }: SetupPlanFacade = require('./setup-plan');

function getJournalPath(): string {
  return path.join(path.dirname(getSettingsFile()), 'setup-undo-journal.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSetupJournal(value: unknown): value is SetupJournal {
  return isRecord(value) && Array.isArray(value.entries);
}

function emptyJournal(): SetupJournal {
  return { version: 1, entries: [] };
}

function loadJournal(): SetupJournal {
  const journalPath = getJournalPath();
  if (!fs.existsSync(journalPath)) {
    return emptyJournal();
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (!isSetupJournal(parsed)) {
      return emptyJournal();
    }
    return parsed;
  } catch {
    return emptyJournal();
  }
}

function saveJournal(journal: SetupJournal): void {
  const journalPath = getJournalPath();
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
}

function entryKey(entry: JournalEntry): string {
  return `${entry.scope}:${entry.repoRoot || ''}:${entry.path}`;
}

// Re-applying an already-journaled write updates appliedValue/appliedAt but
// keeps the original priorValue — that's the true pre-apply state undo must
// restore to, and it must not drift across repeated `apply` runs.
function upsertJournalEntry(journal: SetupJournal, entry: JournalEntry): void {
  const key = entryKey(entry);
  const existingIndex = journal.entries.findIndex((candidate) => entryKey(candidate) === key);
  if (existingIndex === -1) {
    journal.entries.push(entry);
    return;
  }
  const existing = journal.entries[existingIndex];
  if (!existing) {
    throw new Error('Journal entry disappeared during synchronous update');
  }
  journal.entries[existingIndex] = {
    ...entry,
    priorValue: existing.priorValue,
  };
}

function safePathSegments(pathStr: string): string[] {
  const keys = pathStr.split('.');
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Unsafe setup journal path: ${pathStr}`);
    }
  }
  return keys;
}

function defineOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function setNestedValue(target: Record<string, unknown>, pathStr: string, value: unknown): void {
  const keys = safePathSegments(pathStr);
  let node = target;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index] || '';
    const child = Object.hasOwn(node, key) ? node[key] : undefined;
    if (isRecord(child)) {
      node = child;
    } else {
      const replacement: Record<string, unknown> = {};
      defineOwnValue(node, key, replacement);
      node = replacement;
    }
  }
  defineOwnValue(node, keys[keys.length - 1] || '', value);
}

function deleteNestedKey(target: Record<string, unknown>, pathStr: string): void {
  const keys = safePathSegments(pathStr);
  let node = target;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index] || '';
    if (!Object.hasOwn(node, key)) return;
    const child = node[key];
    if (!isRecord(child)) return;
    node = child;
  }
  const finalKey = keys[keys.length - 1] || '';
  if (Object.hasOwn(node, finalKey)) {
    delete node[finalKey];
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      deepEqual(Reflect.get(left, key), Reflect.get(right, key))
  );
}

export = {
  getJournalPath,
  loadJournal,
  saveJournal,
  upsertJournalEntry,
  getNestedValue,
  setNestedValue,
  deleteNestedKey,
  deepEqual,
};
