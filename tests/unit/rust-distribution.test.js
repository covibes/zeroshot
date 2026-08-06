const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  shim,
  temporaryDirectory,
  withRustStageFixture,
} = require('./rust-distribution-support');

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

function registerVersionCouplingTests() {
  it('fails a release version mismatch with the named error and both versions', function () {
    const cargoToml = '[package]\nname = "zeroshot-rust"\nversion = "1.2.2"\n';
    assert.throws(
      () => distribution.checkVersionCoupling('v1.2.3', cargoToml),
      /RUST_VERSION_MISMATCH: release tag version 1\.2\.3.*Cargo\.toml version 1\.2\.2/
    );
    assert.strictEqual(distribution.checkVersionCoupling('v1.2.2', cargoToml), '1.2.2');
  });

  it('stages the planned version and target lock resolution before coupling', function () {
    withRustStageFixture(
      {
        requirement: '0.61.2',
        lockedDependencies: [{ version: '0.52.0' }, { version: '0.61.2' }],
      },
      ({ lockPath, manifestPath, workspacePath }) => {
        assert.deepStrictEqual(
          distribution.stageVersion('v6.10.3', manifestPath, lockPath, workspacePath),
          {
            currentVersion: '0.1.0',
            version: '6.10.3',
          }
        );
        const stagedManifest = fs.readFileSync(manifestPath, 'utf8');
        const stagedLock = fs.readFileSync(lockPath, 'utf8');
        const workspaceManifest = fs.readFileSync(workspacePath, 'utf8');
        assert.strictEqual(
          distribution.checkVersionCoupling(
            'v6.10.3',
            stagedManifest,
            stagedLock,
            workspaceManifest
          ),
          '6.10.3'
        );
        assert.match(
          stagedLock,
          /name = "zeroshot-rust"\nversion = "6\.10\.3"[\s\S]*"windows-sys 0\.61\.2"/
        );
        assert.throws(
          () =>
            distribution.checkVersionCoupling(
              'v6.10.3',
              stagedManifest,
              stagedLock.replace('"windows-sys 0.61.2"', '"windows-sys"'),
              workspaceManifest
            ),
          /RUST_VERSION_MISMATCH: Cargo\.lock zeroshot-rust dependency windows-sys/
        );
        assert.throws(
          () =>
            distribution.checkVersionCoupling(
              'v6.10.3',
              stagedManifest,
              stagedLock.replace('version = "6.10.3"', 'version = "0.1.0"'),
              workspaceManifest
            ),
          /RUST_VERSION_MISMATCH: release tag version 6\.10\.3.*Cargo\.lock.*0\.1\.0/
        );
      }
    );
  });
}

function registerLockResolutionTests() {
  it('resolves supported Cargo requirements without collapsing lock identities', function () {
    const registry = 'registry+https://github.com/rust-lang/crates.io-index';
    withRustStageFixture(
      {
        requirement: '0.61.2',
        lockedDependencies: [
          { version: '0.52.0', source: registry },
          { version: '0.61.3', source: registry },
        ],
        includeRegistryNameCollision: true,
        trailingTables: [
          '[[patch.unused]]',
          'name = "unused-windows-sys"',
          'version = "0.1.0"',
          'source = "git+https://example.invalid/unused?rev=fixture"',
          '',
        ],
      },
      ({ lockPath, manifestPath, workspacePath }) => {
        distribution.stageVersion('v6.10.3', manifestPath, lockPath, workspacePath);
        const lock = fs.readFileSync(lockPath, 'utf8');
        assert.match(lock, /name = "zeroshot-rust"\nversion = "99\.0\.0"\nsource =/);
        assert.match(
          lock,
          /name = "zeroshot-rust"\nversion = "6\.10\.3"[\s\S]*"windows-sys 0\.61\.3"/
        );
        assert.match(lock, /\[\[patch\.unused\]\][\s\S]*source = "git\+https:/);
      }
    );
    withRustStageFixture(
      {
        requirement: '=0.61.2',
        lockedDependencies: [
          { version: '0.61.2', source: registry },
          { version: '0.61.3', source: registry },
        ],
        trailingTables: ['[metadata]', 'fixture = "preserved"', ''],
      },
      ({ lockPath, manifestPath, workspacePath }) => {
        distribution.stageVersion('v6.10.3', manifestPath, lockPath, workspacePath);
        assert.match(fs.readFileSync(lockPath, 'utf8'), /"windows-sys 0\.61\.2"/);
        assert.match(fs.readFileSync(lockPath, 'utf8'), /\[metadata\]\nfixture = "preserved"/);
      }
    );
    withRustStageFixture(
      {
        requirement: '0.61.2',
        lockedDependencies: [
          { version: '0.61.2', source: registry },
          { version: '0.61.3', source: registry },
        ],
      },
      ({ lockPath, manifestPath, workspacePath }) => {
        assert.throws(
          () => distribution.stageVersion('v6.10.3', manifestPath, lockPath, workspacePath),
          /needs exactly one windows-sys package satisfying 0\.61\.2/
        );
      }
    );
    withRustStageFixture(
      {
        requirement: '=0.61.2',
        lockedDependencies: [
          { version: '0.61.2', source: registry },
          {
            version: '0.61.2',
            source: 'git+https://example.invalid/windows-rs?rev=fixture',
          },
        ],
      },
      ({ lockPath, manifestPath, workspacePath }) => {
        assert.throws(
          () => distribution.stageVersion('v6.10.3', manifestPath, lockPath, workspacePath),
          /windows-sys 0\.61\.2 has ambiguous sources/
        );
      }
    );
  });
}

describe('Rust release integration', function () {
  registerVersionCouplingTests();
  registerLockResolutionTests();
});
