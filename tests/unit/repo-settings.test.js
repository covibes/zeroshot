/**
 * Test: repo-local settings read/write
 *
 * writeRepoSettings() + readRepoSettings() round-trip against a real
 * `.zeroshot/settings.json` in a temp git repo.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { readRepoSettings, writeRepoSettings } = require('../../lib/repo-settings');

describe('repo-settings', function () {
  this.timeout(10000);

  let repoRoot;

  beforeEach(function () {
    repoRoot = path.join(
      os.tmpdir(),
      'zeroshot-repo-settings-test-' + crypto.randomBytes(8).toString('hex')
    );
    fs.mkdirSync(repoRoot, { recursive: true });
    execSync('git init', { cwd: repoRoot, stdio: 'ignore' });
  });

  afterEach(function () {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('preserves the CommonJS export surface', function () {
    const repoSettings = require('../../lib/repo-settings');
    assert.deepStrictEqual(Reflect.ownKeys(repoSettings), [
      'readRepoSettings',
      'writeRepoSettings',
    ]);
    assert.deepStrictEqual(
      Object.values(repoSettings).map((value) => value.length),
      [1, 2]
    );
  });

  it('writeRepoSettings creates .zeroshot/settings.json', function () {
    const settingsPath = writeRepoSettings(repoRoot, { prBase: 'main' });
    assert.strictEqual(settingsPath, path.join(repoRoot, '.zeroshot', 'settings.json'));
    assert.ok(fs.existsSync(settingsPath));
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{\n  "prBase": "main"\n}');
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(onDisk, { prBase: 'main' });
  });

  it('readRepoSettings round-trips what writeRepoSettings wrote', function () {
    writeRepoSettings(repoRoot, { prBase: 'dev', dockerMounts: ['gh', 'git'] });
    const { repoRoot: detectedRoot, settings, settingsPath } = readRepoSettings(repoRoot);
    // git resolves symlinks (e.g. macOS /tmp -> /private/tmp), so compare via realpath.
    assert.strictEqual(
      settingsPath,
      path.join(fs.realpathSync(repoRoot), '.zeroshot', 'settings.json')
    );
    assert.ok(detectedRoot);
    assert.deepStrictEqual(settings, { prBase: 'dev', dockerMounts: ['gh', 'git'] });
  });

  it('writeRepoSettings overwrites a previous file', function () {
    writeRepoSettings(repoRoot, { prBase: 'main' });
    writeRepoSettings(repoRoot, { prBase: 'dev' });
    const { settings } = readRepoSettings(repoRoot);
    assert.deepStrictEqual(settings, { prBase: 'dev' });
  });

  it('readRepoSettings returns null settings when no file exists yet', function () {
    const { settings, repoRoot: detectedRoot } = readRepoSettings(repoRoot);
    assert.strictEqual(settings, null);
    assert.ok(detectedRoot);
  });

  it('returns null settings for malformed or primitive JSON', function () {
    const settingsPath = path.join(repoRoot, '.zeroshot', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{broken', 'utf8');
    assert.strictEqual(readRepoSettings(repoRoot).settings, null);
    fs.writeFileSync(settingsPath, '42', 'utf8');
    assert.strictEqual(readRepoSettings(repoRoot).settings, null);
  });

  it('preserves arrays because JSON arrays are objects at the compatibility boundary', function () {
    const settingsPath = path.join(repoRoot, '.zeroshot', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '["legacy"]', 'utf8');
    assert.deepStrictEqual(readRepoSettings(repoRoot).settings, ['legacy']);
  });
});
