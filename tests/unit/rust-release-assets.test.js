const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { distribution, temporaryDirectory } = require('./rust-distribution-support');

describe('Rust release asset recovery', function () {
  it('verifies existing assets before uploading only missing names', function () {
    const directory = temporaryDirectory();
    const binaryPath = path.join(directory, 'fixture-binary');
    fs.writeFileSync(binaryPath, 'binary');
    for (const { target } of distribution.targets) {
      distribution.packageTarget({
        target,
        version: '6.10.3',
        binaryPath,
        outputDirectory: directory,
      });
    }
    distribution.createManifest({ version: '6.10.3', directory });
    const existingName = distribution.archiveName('6.10.3', distribution.targets[0].target);
    const uploads = [];
    const invokeGh = (args) => {
      if (args[1] === 'view') return JSON.stringify({ assets: [{ name: existingName }] });
      if (args[1] === 'download') {
        const output = args[args.indexOf('--dir') + 1];
        fs.writeFileSync(
          path.join(output, existingName),
          fs.readFileSync(path.join(directory, existingName))
        );
        return '';
      }
      if (args[1] === 'upload') {
        uploads.push(path.basename(args[3]));
        assert(!args.includes('--clobber'));
        return '';
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    };
    try {
      const result = distribution.publishAssets({
        tag: 'zeroshot-rust-v6.10.3',
        directory,
        invokeGh,
      });
      assert.deepStrictEqual(result.existing, [existingName]);
      assert.strictEqual(result.uploaded.length, distribution.targets.length);
      assert.deepStrictEqual(uploads, result.uploaded);

      const conflictUploads = [];
      assert.throws(
        () =>
          distribution.publishAssets({
            tag: 'zeroshot-rust-v6.10.3',
            directory,
            invokeGh: (args) => {
              if (args[1] === 'view') {
                return JSON.stringify({ assets: [{ name: existingName }] });
              }
              if (args[1] === 'download') {
                const output = args[args.indexOf('--dir') + 1];
                fs.writeFileSync(path.join(output, existingName), 'different');
                return '';
              }
              conflictUploads.push(args);
              return '';
            },
          }),
        /RELEASE_ASSET_CONFLICT.*differs/
      );
      assert.deepStrictEqual(conflictUploads, []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
