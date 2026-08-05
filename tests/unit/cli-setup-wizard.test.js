const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', '..', 'cli', 'index.js');

describe('setup wizard CLI integration', function () {
  it('routes bare setup to the wizard and gives non-TTY recovery commands', function () {
    const result = spawnSync(process.execPath, [CLI_PATH, 'setup'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stdout, /Interactive setup requires a TTY/);
    assert.match(result.stdout, /zeroshot setup plan/);
    assert.match(result.stdout, /zeroshot setup apply --decisions <file>/);
  });
});
