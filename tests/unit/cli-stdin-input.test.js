/**
 * Test: stdin task input ('zeroshot run -')
 *
 * Ensures piped/redirected task bodies are preserved verbatim, avoiding
 * shell-quoting breakage from inline args.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const {
  isStdinInput,
  readStdinText,
  encodeStdinEnv,
  decodeStdinEnv,
  buildTextInput,
} = require('../../lib/start-cluster');

const repoRoot = path.join(__dirname, '..', '..');

describe('CLI stdin task input', function () {
  describe('isStdinInput', function () {
    it('recognizes the "-" marker', function () {
      assert.strictEqual(isStdinInput('-'), true);
    });

    it('rejects issue numbers, files, and plain text', function () {
      assert.strictEqual(isStdinInput('123'), false);
      assert.strictEqual(isStdinInput('feature.md'), false);
      assert.strictEqual(isStdinInput('some text'), false);
    });
  });

  describe('readStdinText', function () {
    it('collects and trims piped chunks', async function () {
      const stream = Readable.from(['line1\n', 'line2\n']);
      const text = await readStdinText(stream);
      assert.strictEqual(text, 'line1\nline2');
    });

    it('resolves to empty string for empty stdin', async function () {
      const stream = Readable.from([]);
      const text = await readStdinText(stream);
      assert.strictEqual(text, '');
    });
  });

  describe('encodeStdinEnv / decodeStdinEnv', function () {
    it('round-trips text containing shell metacharacters and unicode', function () {
      const text = 'BrandContext.writingStyle `backtick` $(command) über\nmultiline';
      const encoded = encodeStdinEnv(text);
      const decoded = decodeStdinEnv(encoded);
      assert.strictEqual(decoded, text);
    });

    it('produces unmodified text input after round-trip', function () {
      const text = 'echo `whoami` $(rm -rf /)';
      const result = buildTextInput(decodeStdinEnv(encodeStdinEnv(text)));
      assert.deepStrictEqual(result, { text });
    });
  });

  it('preserves piped stdin through a real Node process boundary', function () {
    const taskBody = [
      '# Task',
      '',
      'Update `BrandContext.writingStyle` without evaluating $(shell) syntax.',
    ].join('\n');
    const script = `
      const { readStdinText, buildTextInput } = require(${JSON.stringify(
        path.join(repoRoot, 'lib/start-cluster')
      )});
      readStdinText()
        .then((text) => process.stdout.write(JSON.stringify(buildTextInput(text))))
        .catch((error) => {
          console.error(error.stack || error.message);
          process.exit(1);
        });
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      input: taskBody,
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { text: taskBody });
  });

  it('excludes piped run input before settings, registry, or stdin work', function () {
    const { checkForUpdates } = require('../../cli/lib/update-checker');
    const sentinel = Readable.from(['byte-for-byte input']);
    let settingsLoads = 0;
    let fetches = 0;

    const result = checkForUpdates({
      argv: ['run', '-'],
      env: {},
      packageName: '@the-open-engine/zeroshot',
      currentVersion: '1.0.0',
      stdin: sentinel,
      stdout: { isTTY: false },
      stderr: { isTTY: false, write: () => assert.fail('unexpected update notice') },
      loadSettings: () => {
        settingsLoads += 1;
        return {
          autoCheckUpdates: true,
          lastSeenVersion: '2.0.0',
          lastUpdateCheckAt: null,
        };
      },
      fetchLatestVersion: async () => {
        fetches += 1;
        return '2.0.0';
      },
    });

    assert.strictEqual(result, null);
    assert.strictEqual(settingsLoads, 0);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(sentinel.read().toString(), 'byte-for-byte input');
  });
});
