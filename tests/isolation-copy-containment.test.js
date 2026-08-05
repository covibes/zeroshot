const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IsolationManager = require('../src/isolation-manager');
const {
  CONTAINMENT_ERROR_CODE,
  CopyContainmentError,
  createCopyBoundary,
  resolveCopyPath,
} = require('../src/copy-containment');

function writeFlatFiles(directory, count) {
  for (let index = 0; index < count; index++) {
    fs.writeFileSync(path.join(directory, `file-${index}.txt`), `content-${index}`);
  }
}

function isContainmentError(error) {
  return error?.code === CONTAINMENT_ERROR_CODE && /containment/i.test(error.message);
}

async function captureContainmentError(copyPromise) {
  try {
    await copyPromise;
    assert.fail('expected copy containment to reject');
  } catch (error) {
    assert.ok(error instanceof CopyContainmentError, error.stack || error.message);
    assert.strictEqual(isContainmentError(error), true);
    return error;
  }
}

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

  it('rejects absolute and traversal-bearing relative paths before normalization', function () {
    fs.writeFileSync(path.join(sourceRoot, 'safe.txt'), 'safe');
    const boundary = createCopyBoundary(sourceRoot, destinationRoot);

    for (const unsafePath of [
      ['..', 'escape'].join(path.sep),
      ['nested', '..', '..', 'escape'].join(path.sep),
      path.resolve(fixtureRoot, 'absolute'),
    ]) {
      assert.throws(() => resolveCopyPath(boundary, unsafePath), isContainmentError);
    }
  });

  if (path.sep === '/') {
    it('preserves POSIX filenames that contain Windows-looking separators', async function () {
      for (const fileName of ['C:\\literal', '\\leading', 'literal\\..\\name']) {
        fs.writeFileSync(path.join(sourceRoot, fileName), fileName);
      }

      await manager._copyDirExcluding(sourceRoot, destinationRoot, []);

      for (const fileName of ['C:\\literal', '\\leading', 'literal\\..\\name']) {
        assert.strictEqual(fs.readFileSync(path.join(destinationRoot, fileName), 'utf8'), fileName);
      }
    });
  }

  for (const fileCount of [1, 100]) {
    const mode = fileCount < 100 ? 'synchronous' : 'worker';

    it(`copies ordinary nested files through the ${mode} path`, async function () {
      const nestedSource = path.join(sourceRoot, 'nested');
      fs.mkdirSync(nestedSource);
      writeFlatFiles(nestedSource, fileCount);

      await manager._copyDirExcluding(sourceRoot, destinationRoot, []);

      assert.strictEqual(
        fs.readFileSync(path.join(destinationRoot, 'nested', `file-${fileCount - 1}.txt`), 'utf8'),
        `content-${fileCount - 1}`
      );
    });
  }

  for (const fillerCount of [0, 96]) {
    const mode = fillerCount === 0 ? 'synchronous' : 'worker';

    it(`preserves in-root source file and directory symlinks through the ${mode} path`, async function () {
      fs.mkdirSync(path.join(sourceRoot, 'targets', 'directory'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'targets', 'file.txt'), 'file target');
      fs.writeFileSync(path.join(sourceRoot, 'targets', 'directory', 'nested.txt'), 'dir target');
      fs.symlinkSync(
        path.join(sourceRoot, 'targets', 'file.txt'),
        path.join(sourceRoot, 'file-alias.txt')
      );
      fs.symlinkSync(
        path.join(sourceRoot, 'targets', 'directory'),
        path.join(sourceRoot, 'directory-alias'),
        'dir'
      );
      writeFlatFiles(sourceRoot, fillerCount);

      await manager._copyDirExcluding(sourceRoot, destinationRoot, []);

      assert.strictEqual(
        fs.readFileSync(path.join(destinationRoot, 'file-alias.txt'), 'utf8'),
        'file target'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(destinationRoot, 'directory-alias', 'nested.txt'), 'utf8'),
        'dir target'
      );
    });
  }

  for (const fillerCount of [0, 98]) {
    const mode = fillerCount === 0 ? 'synchronous' : 'worker';

    it(`permits destination symlinks whose targets stay in-root through the ${mode} path`, async function () {
      fs.mkdirSync(path.join(sourceRoot, 'nested'));
      fs.writeFileSync(path.join(sourceRoot, 'nested', 'file.txt'), 'nested content');
      fs.writeFileSync(path.join(sourceRoot, 'alias.txt'), 'replacement');
      writeFlatFiles(sourceRoot, fillerCount);
      fs.mkdirSync(path.join(destinationRoot, 'storage'));
      fs.writeFileSync(path.join(destinationRoot, 'storage', 'target.txt'), 'old content');
      fs.symlinkSync(
        path.join(destinationRoot, 'storage'),
        path.join(destinationRoot, 'nested'),
        'dir'
      );
      fs.symlinkSync(
        path.join(destinationRoot, 'storage', 'target.txt'),
        path.join(destinationRoot, 'alias.txt')
      );

      await manager._copyDirExcluding(sourceRoot, destinationRoot, []);

      assert.strictEqual(
        fs.readFileSync(path.join(destinationRoot, 'storage', 'file.txt'), 'utf8'),
        'nested content'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(destinationRoot, 'storage', 'target.txt'), 'utf8'),
        'replacement'
      );
    });
  }

  it('continues to ignore an ordinary broken source symlink', async function () {
    fs.symlinkSync(path.join(sourceRoot, 'missing.txt'), path.join(sourceRoot, 'broken.txt'));

    await manager._copyDirExcluding(sourceRoot, destinationRoot, []);

    assert.strictEqual(fs.existsSync(path.join(destinationRoot, 'broken.txt')), false);
  });

  it('fails closed on an in-root source directory symlink cycle', async function () {
    fs.symlinkSync(sourceRoot, path.join(sourceRoot, 'loop'), 'dir');

    await assert.rejects(
      manager._copyDirExcluding(sourceRoot, destinationRoot, []),
      isContainmentError
    );
  });

  it('rejects a source directory symlink that resolves outside the pinned root', async function () {
    fs.mkdirSync(path.join(outsideRoot, 'directory'));
    fs.writeFileSync(path.join(outsideRoot, 'directory', 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outsideRoot, 'directory'), path.join(sourceRoot, 'escape'), 'dir');

    await assert.rejects(
      manager._copyDirExcluding(sourceRoot, destinationRoot, []),
      isContainmentError
    );
    assert.strictEqual(fs.existsSync(path.join(destinationRoot, 'escape')), false);
  });

  for (const fileCount of [99, 100]) {
    const mode = fileCount < 100 ? 'synchronous' : 'worker';

    it(`rejects a raw traversal entry before the ${mode} path can normalize it`, async function () {
      writeFlatFiles(sourceRoot, fileCount - 1);
      const originalReaddirSync = fs.readdirSync;
      fs.readdirSync = function (targetPath, options) {
        const entries = originalReaddirSync.call(fs, targetPath, options);
        if (path.resolve(targetPath) === fs.realpathSync(sourceRoot)) {
          entries.push({
            name: ['..', 'escape.txt'].join(path.sep),
            isDirectory: () => false,
            isSymbolicLink: () => false,
          });
        }
        return entries;
      };

      try {
        const error = await captureContainmentError(
          manager._copyDirExcluding(sourceRoot, destinationRoot, [])
        );
        assert.strictEqual(error.relativePath, ['..', 'escape.txt'].join(path.sep));
      } finally {
        fs.readdirSync = originalReaddirSync;
      }
    });

    it(`rejects an escaping source file symlink through the ${mode} path`, async function () {
      writeFlatFiles(sourceRoot, fileCount - 1);
      const outsideFile = path.join(outsideRoot, 'secret.txt');
      fs.writeFileSync(outsideFile, 'outside');
      fs.symlinkSync(outsideFile, path.join(sourceRoot, 'escape.txt'));

      const error = await captureContainmentError(
        manager._copyDirExcluding(sourceRoot, destinationRoot, [])
      );
      assert.strictEqual(error.relativePath, 'escape.txt');
      assert.strictEqual(fs.existsSync(path.join(destinationRoot, 'escape.txt')), false);
    });

    it(`rejects an escaping destination file symlink through the ${mode} path`, async function () {
      writeFlatFiles(sourceRoot, fileCount - 1);
      fs.writeFileSync(path.join(sourceRoot, 'escape.txt'), 'replacement');
      const outsideFile = path.join(outsideRoot, 'victim.txt');
      fs.writeFileSync(outsideFile, 'unchanged');
      fs.symlinkSync(outsideFile, path.join(destinationRoot, 'escape.txt'));

      const error = await captureContainmentError(
        manager._copyDirExcluding(sourceRoot, destinationRoot, [])
      );
      assert.strictEqual(error.relativePath, 'escape.txt');
      assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'unchanged');
    });
  }

  it('rejects a broken destination symlink instead of treating it as a missing path', async function () {
    fs.writeFileSync(path.join(sourceRoot, 'escape.txt'), 'replacement');
    fs.symlinkSync(path.join(outsideRoot, 'missing.txt'), path.join(destinationRoot, 'escape.txt'));

    await assert.rejects(
      manager._copyDirExcluding(sourceRoot, destinationRoot, []),
      isContainmentError
    );
    assert.strictEqual(fs.existsSync(path.join(outsideRoot, 'missing.txt')), false);
  });

  it('detects replacement of a pinned root before resolving an effect path', function () {
    fs.writeFileSync(path.join(sourceRoot, 'file.txt'), 'content');
    const boundary = createCopyBoundary(sourceRoot, destinationRoot);
    const originalDestination = path.join(fixtureRoot, 'original-destination');
    fs.renameSync(destinationRoot, originalDestination);
    fs.mkdirSync(destinationRoot);

    assert.throws(() => resolveCopyPath(boundary, 'file.txt'), isContainmentError);
  });

  it('propagates unexpected worker copy failures to the caller', async function () {
    writeFlatFiles(sourceRoot, 100);
    fs.mkdirSync(path.join(destinationRoot, 'file-99.txt'));

    await assert.rejects(
      manager._copyDirExcluding(sourceRoot, destinationRoot, []),
      (error) => error?.code === 'EISDIR' && /directory/i.test(error.message)
    );
  });
});
