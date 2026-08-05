const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IsolationManager = require('../src/isolation-manager');

describe('isolation copy containment', function () {
  let fixtureRoot;
  let sourceRoot;
  let destinationRoot;
  let outsideRoot;
  let manager;

  beforeEach(function () {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-copy-containment-'));
    sourceRoot = path.join(fixtureRoot, 'source');
    destinationRoot = path.join(fixtureRoot, 'destination');
    outsideRoot = path.join(fixtureRoot, 'outside');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(destinationRoot);
    fs.mkdirSync(outsideRoot);
    manager = new IsolationManager();
  });

  afterEach(function () {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('fails closed before directory creation follows an escaping destination symlink', async function () {
    fs.mkdirSync(path.join(sourceRoot, 'nested', 'child'), { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(destinationRoot, 'nested'), 'dir');

    await assert.rejects(
      manager._copyDirExcluding(sourceRoot, destinationRoot, []),
      /containment/i
    );

    assert.strictEqual(fs.existsSync(path.join(outsideRoot, 'child')), false);
  });
});
