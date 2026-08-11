const assert = require('node:assert/strict');

const setupJournal = require('../../lib/setup-journal');

function entry(overrides = {}) {
  return {
    scope: 'global',
    path: 'providerSettings.claude',
    repoRoot: null,
    priorValue: { minLevel: 'level1' },
    appliedValue: { minLevel: 'level2' },
    appliedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('setup-journal CommonJS API', () => {
  it('preserves the export surface and function arities', () => {
    assert.deepStrictEqual(Reflect.ownKeys(setupJournal), [
      'getJournalPath',
      'loadJournal',
      'saveJournal',
      'upsertJournalEntry',
      'getNestedValue',
      'setNestedValue',
      'deleteNestedKey',
      'deepEqual',
    ]);
    assert.deepStrictEqual(
      Object.values(setupJournal).map((value) => value.length),
      [0, 0, 1, 2, 2, 3, 2, 2]
    );
  });
});

describe('setup-journal shared mutation semantics', () => {
  it('sets and deletes nested values without disturbing siblings', () => {
    const settings = { providerSettings: { codex: { minLevel: 'level1' } } };

    setupJournal.setNestedValue(settings, 'providerSettings.claude.minLevel', 'level2');
    assert.deepStrictEqual(settings, {
      providerSettings: {
        codex: { minLevel: 'level1' },
        claude: { minLevel: 'level2' },
      },
    });
    assert.strictEqual(
      setupJournal.getNestedValue(settings, 'providerSettings.claude.minLevel'),
      'level2'
    );

    setupJournal.deleteNestedKey(settings, 'providerSettings.claude.minLevel');
    assert.deepStrictEqual(settings.providerSettings.claude, {});
    assert.deepStrictEqual(settings.providerSettings.codex, { minLevel: 'level1' });
  });

  it('keeps the original prior value when a journal entry is reapplied', () => {
    const original = entry();
    const journal = { version: 1, entries: [original] };
    const reapplied = entry({
      priorValue: { minLevel: 'level2' },
      appliedValue: { minLevel: 'level3' },
      appliedAt: '2026-01-02T00:00:00.000Z',
    });

    setupJournal.upsertJournalEntry(journal, reapplied);

    assert.deepStrictEqual(journal.entries, [
      {
        ...reapplied,
        priorValue: original.priorValue,
      },
    ]);
  });

  it('uses structural equality for arrays and objects', () => {
    assert.strictEqual(
      setupJournal.deepEqual(
        { nested: ['value', { enabled: true }] },
        { nested: ['value', { enabled: true }] }
      ),
      true
    );
    assert.strictEqual(setupJournal.deepEqual([1, 2], [2, 1]), false);
    assert.strictEqual(setupJournal.deepEqual({ value: 1 }, { value: 2 }), false);
  });
});
