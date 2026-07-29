const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const distribution = require('../../scripts/rust-distribution');
const shim = require('../../npm/zeroshot-rust/lib/install');

const projectRoot = path.resolve(__dirname, '..', '..');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-rust-distribution-'));
}

function relativeFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? relativeFiles(root, absolute) : [path.relative(root, absolute)];
  });
}

describe('Rust product distribution', function () {
  it('declares the complete native target and host matrix', function () {
    assert.deepStrictEqual(
      distribution.targets.map(({ target }) => target),
      [
        'x86_64-unknown-linux-gnu',
        'aarch64-unknown-linux-gnu',
        'x86_64-apple-darwin',
        'aarch64-apple-darwin',
        'x86_64-pc-windows-msvc',
      ]
    );
    for (const declaration of distribution.targets) {
      assert.strictEqual(
        distribution.targetForHost(declaration.platform, declaration.arch).target,
        declaration.target
      );
      assert.strictEqual(
        shim.selectTarget(declaration.platform, declaration.arch).target,
        declaration.target
      );
    }
  });

  it('fails closed for an unsupported host without selecting a fallback', function () {
    assert.throws(
      () => shim.selectTarget('freebsd', 'riscv64'),
      /UNSUPPORTED_ZEROSHOT_RUST_HOST.*freebsd\/riscv64/
    );
    assert.throws(
      () => distribution.targetForHost('linux', 'ia32'),
      /UNSUPPORTED_ZEROSHOT_RUST_HOST.*linux\/ia32/
    );
  });

  it('dry-runs every archive and verifies one complete SHA256SUMS', function () {
    const directory = temporaryDirectory();
    const binaryPath = path.join(directory, 'fixture-binary');
    const binary = Buffer.from('#!/bin/sh\nexit 0\n');
    fs.writeFileSync(binaryPath, binary);
    try {
      for (const { target } of distribution.targets) {
        distribution.packageTarget({
          target,
          version: '1.2.3',
          binaryPath,
          outputDirectory: directory,
        });
      }
      const manifestText = distribution.createManifest({ version: '1.2.3', directory });
      const manifest = distribution.parseChecksumManifest(manifestText);
      assert.strictEqual(manifest.size, distribution.targets.length);
      for (const declaration of distribution.targets) {
        const filename = distribution.archiveName('1.2.3', declaration.target);
        const archive = fs.readFileSync(path.join(directory, filename));
        assert(distribution.verifyChecksum(filename, archive, manifest));
        assert.deepStrictEqual(archive, distribution.createArchive(binary, declaration.executable));
        assert.deepStrictEqual(
          distribution.extractExecutable(archive, declaration.executable),
          binary
        );
        assert.deepStrictEqual(shim.extractExecutable(archive, declaration.executable), binary);
      }
      assert.deepStrictEqual(
        fs.readdirSync(directory).filter((name) => name.endsWith('.tar.gz')).length,
        distribution.targets.length
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects corrupt archives before extraction', function () {
    const archive = distribution.createArchive(Buffer.from('binary'), 'zeroshot-rust');
    const filename = distribution.archiveName('1.2.3', 'x86_64-unknown-linux-gnu');
    const manifest = `${'0'.repeat(64)}  ${filename}\n`;
    assert.throws(() => shim.verifyArchive(filename, archive, manifest), /CHECKSUM_MISMATCH/);
  });
});

describe('Rust release integration', function () {
  it('fails a release version mismatch with the named error and both versions', function () {
    const cargoToml = '[package]\nname = "zeroshot-rust"\nversion = "1.2.2"\n';
    assert.throws(
      () => distribution.checkVersionCoupling('v1.2.3', cargoToml),
      /RUST_VERSION_MISMATCH: release tag version 1\.2\.3.*Cargo\.toml version 1\.2\.2/
    );
    assert.strictEqual(distribution.checkVersionCoupling('v1.2.2', cargoToml), '1.2.2');
  });

  it('guards the workflow matrix and artifact/checksum mechanism', function () {
    const workflow = fs.readFileSync(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    assert.strictEqual(distribution.checkRepository(workflow), true);
    const missingTarget = workflow.replace(
      /\n\s+- target: aarch64-apple-darwin\n\s+runner: macos-14\n\s+executable: zeroshot-rust\n\s+c-compiler: cc/,
      ''
    );
    assert.throws(
      () => distribution.checkRepository(missingTarget),
      /workflow matrix differs from declared targets.*aarch64-apple-darwin/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow.replaceAll('actions/upload-artifact@', 'actions/not-upload@')
        ),
      /release workflow is missing actions\/upload-artifact@/
    );
  });

  it('installs only a checksum-verified archive selected for the host', async function () {
    const packageRoot = temporaryDirectory();
    const binary = Buffer.from('standalone native fixture');
    const target = 'x86_64-unknown-linux-gnu';
    const filename = distribution.archiveName('1.2.3', target);
    const archive = distribution.createArchive(binary, 'zeroshot-rust');
    const manifest = Buffer.from(`${distribution.sha256(archive)}  ${filename}\n`);
    const requested = [];
    try {
      const destination = await shim.install({
        packageRoot,
        packageMetadata: { version: '1.2.3' },
        platform: 'linux',
        arch: 'x64',
        fetchBuffer: (url) => {
          requested.push(url);
          return Promise.resolve(url.endsWith('/SHA256SUMS') ? manifest : archive);
        },
      });
      assert.deepStrictEqual(fs.readFileSync(destination), binary);
      assert.deepStrictEqual(requested, [
        `${shim.RELEASE_BASE_URL}/v1.2.3/SHA256SUMS`,
        `${shim.RELEASE_BASE_URL}/v1.2.3/${filename}`,
      ]);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('leaves no executable behind when shim verification fails', async function () {
    const packageRoot = temporaryDirectory();
    try {
      await assert.rejects(
        shim.install({
          packageRoot,
          packageMetadata: { version: '1.2.3' },
          platform: 'linux',
          arch: 'x64',
          fetchBuffer: (url) =>
            Promise.resolve(
              url.endsWith('/SHA256SUMS')
                ? Buffer.from(
                    `${'0'.repeat(64)}  zeroshot-rust-v1.2.3-x86_64-unknown-linux-gnu.tar.gz\n`
                  )
                : distribution.createArchive(Buffer.from('untrusted'), 'zeroshot-rust')
            ),
        }),
        /CHECKSUM_MISMATCH/
      );
      assert(!fs.existsSync(path.join(packageRoot, 'bin', 'native', 'zeroshot-rust')));
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('keeps native metadata outside the Rust-only product and the Node package', function () {
    const rustRoot = path.join(projectRoot, 'zeroshot-rust');
    for (const file of relativeFiles(rustRoot)) {
      assert(
        file === 'Cargo.toml' || file.endsWith('.rs'),
        `unexpected non-Rust product file: ${file}`
      );
    }
    assert.strictEqual(
      fs.readFileSync(path.join(rustRoot, 'src', 'main.rs'), 'utf8'),
      'fn main() {}\n'
    );

    const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.deepStrictEqual(rootPackage.files, [
      'src/',
      'lib/',
      'bin/',
      'cli/',
      'task-lib/',
      'cluster-templates/',
      'cluster-hooks/',
      'docker/',
      'scripts/',
      'protocol/openengine-cluster/v1/worker.schema.json',
      'docs/openengine-cluster-protocol/v1/legacy-worker.md',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
    ]);
    assert(!rootPackage.files.some((entry) => entry.startsWith('zeroshot-rust')));
    assert.strictEqual(
      JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'npm', 'zeroshot-rust', 'package.json'), 'utf8')
      ).name,
      '@the-open-engine/zeroshot-rust'
    );
  });
});
