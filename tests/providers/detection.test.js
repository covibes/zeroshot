const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commandExists,
  getCommandPath,
  getHelpOutput,
  getVersionOutput,
} = require('../../lib/provider-detection');

describe('Provider CLI detection', () => {
  it('detects commands by absolute path', () => {
    const nodePath = process.execPath;
    assert.strictEqual(commandExists(nodePath), true);
    assert.strictEqual(getCommandPath(nodePath), nodePath);
  });

  it('returns false for missing commands', () => {
    assert.strictEqual(commandExists('/nonexistent/cli'), false);
    assert.strictEqual(getCommandPath('/nonexistent/cli'), null);
  });

  it('returns help and version output when available', () => {
    const nodePath = process.execPath;
    const help = getHelpOutput(nodePath);
    const version = getVersionOutput(nodePath);

    assert.ok(typeof help === 'string');
    assert.ok(typeof version === 'string');
    assert.ok(version.length > 0);
  });

  it('ignores failing fallback help/version probes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-detect-'));
    const cliPath = path.join(tempDir, 'pi');

    fs.writeFileSync(
      cliPath,
      [
        '#!/usr/bin/env node',
        'if (process.argv.includes("--help")) process.exit(0);',
        'if (process.argv.includes("--version")) { process.stdout.write("0.84.1\\n"); process.exit(0); }',
        'process.stderr.write("unknown option -h\\n"); process.exit(1);',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    try {
      assert.strictEqual(getHelpOutput(cliPath), '');
      assert.strictEqual(getVersionOutput(cliPath), '0.84.1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
