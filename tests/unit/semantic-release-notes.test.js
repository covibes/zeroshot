const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateNotesWithFallback,
  readCuratedNotes,
} = require('../../scripts/semantic-release-notes');

describe('semantic release notes', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-release-notes-'));
    fs.mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses curated notes for the computed version', async function () {
    fs.writeFileSync(
      path.join(root, 'docs', 'releases', 'v6.7.2.md'),
      '# Curated\n\nExact notes.\n'
    );

    const notes = await generateNotesWithFallback(
      {},
      { cwd: root, nextRelease: { version: '6.7.2' } },
      () => {
        throw new Error('fallback must not run');
      }
    );

    assert.strictEqual(notes, '# Curated\n\nExact notes.\n');
  });

  it('falls back to conventional notes when no curated file exists', async function () {
    const notes = await generateNotesWithFallback(
      {},
      { cwd: root, nextRelease: { version: '6.7.3' } },
      () => '## Bug Fixes\n\n* conventional\n'
    );

    assert.strictEqual(notes, '## Bug Fixes\n\n* conventional\n');
    assert.strictEqual(readCuratedNotes(root, '6.7.3'), null);
  });

  it('rejects an empty curated file instead of silently falling back', async function () {
    fs.writeFileSync(path.join(root, 'docs', 'releases', 'v6.7.2.md'), ' \n');

    await assert.rejects(
      generateNotesWithFallback(
        {},
        { cwd: root, nextRelease: { version: '6.7.2' } },
        () => 'fallback'
      ),
      /Curated release notes are empty/
    );
  });
});
