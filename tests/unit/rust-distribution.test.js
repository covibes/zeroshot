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

function mutation(source, before, after = '') {
  assert(source.includes(before), `mutation precondition missing: ${before}`);
  return source.replace(before, after);
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

  it('stages the planned version in Cargo.toml and Cargo.lock before coupling', function () {
    const directory = temporaryDirectory();
    const manifestPath = path.join(directory, 'Cargo.toml');
    const lockPath = path.join(directory, 'Cargo.lock');
    fs.writeFileSync(
      manifestPath,
      '[package]\nname = "zeroshot-rust"\nversion = "0.1.0"\nedition = "2024"\n'
    );
    fs.writeFileSync(
      lockPath,
      'version = 4\n\n[[package]]\nname = "zeroshot-rust"\nversion = "0.1.0"\n'
    );
    try {
      assert.deepStrictEqual(distribution.stageVersion('v6.10.3', manifestPath, lockPath), {
        currentVersion: '0.1.0',
        version: '6.10.3',
      });
      const stagedManifest = fs.readFileSync(manifestPath, 'utf8');
      assert.strictEqual(distribution.checkVersionCoupling('v6.10.3', stagedManifest), '6.10.3');
      assert.match(
        fs.readFileSync(lockPath, 'utf8'),
        /name = "zeroshot-rust"\nversion = "6\.10\.3"/
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('causally guards build, matrix, upload, publication, recovery, and shim integrity', function () {
    const workflow = fs.readFileSync(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    assert.strictEqual(distribution.checkRepository(workflow), true);

    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            'run: cargo build --release --locked -p zeroshot-rust --bin zeroshot-rust --target ${{ matrix.target }}',
            'run: echo cargo build --release --locked -p zeroshot-rust --bin zeroshot-rust --target ${{ matrix.target }}'
          )
        ),
      /build step must execute exactly/
    );
    for (const [before, after, error] of [
      [
        'run: node scripts/rust-distribution.js stage-version --tag "$RELEASE_TAG"',
        'run: echo node scripts/rust-distribution.js stage-version --tag "$RELEASE_TAG"',
        /version staging/,
      ],
      [
        'run: node scripts/rust-distribution.js smoke --binary "$BINARY_PATH"',
        'run: echo node scripts/rust-distribution.js smoke --binary "$BINARY_PATH"',
        /native Rust executable smoke/,
      ],
      [
        'node scripts/rust-distribution.js smoke-archive \\',
        'echo node scripts/rust-distribution.js smoke-archive \\',
        /archive smoke step/,
      ],
      [
        'if ! git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main; then',
        'if ! echo git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main; then',
        /main ancestry verification/,
      ],
    ]) {
      assert.throws(() => distribution.checkRepository(mutation(workflow, before, after)), error);
    }
    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            'needs: [dry-run, release-plan, rust-recovery-plan]',
            'needs: [dry-run, rust-recovery-plan]'
          )
        ),
      /rust-binaries dependencies/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            `      - name: Upload target archive
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: zeroshot-rust-\${{ matrix.target }}
          path: rust-release/*.tar.gz
          if-no-files-found: error
`
          )
        ),
      /Upload target archive|per-target archive upload/
    );
    for (const [before, after] of [
      ['runner: macos-14', 'runner: ubuntu-latest'],
      ['executable: zeroshot-rust.exe', 'executable: zeroshot-rust'],
      ['c-compiler: cl.exe', 'c-compiler: cc'],
    ]) {
      assert.throws(
        () => distribution.checkRepository(mutation(workflow, before, after)),
        /matrix rows differs/
      );
    }
    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(workflow, 'targets: ${{ matrix.target }}', 'targets: x86_64-unknown-linux-gnu')
        ),
      /toolchain setup/
    );
    assert.throws(
      () =>
        distribution.checkRepository(mutation(workflow, 'toolchain: 1.97.0', 'toolchain: stable')),
      /toolchain setup/
    );

    const shimTargets = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'npm', 'zeroshot-rust', 'targets.json'), 'utf8')
    );
    shimTargets[0].target = 'aarch64-unknown-linux-gnu';
    assert.throws(
      () => distribution.checkRepository(workflow, shimTargets),
      /npm shim host mapping/
    );

    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            'needs: [install-matrix, release-plan, rust-manifest]',
            'needs: [install-matrix, release-plan]'
          )
        ),
      /release dependencies/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            'run: node scripts/release-dry-run.js',
            'run: |\n          npx semantic-release\n          node scripts/release-dry-run.js'
          )
        ),
      /semantic-release runs before artifacts/
    );
    assert.throws(
      () =>
        distribution.checkRepository(mutation(workflow, '          - recover-rust-distribution\n')),
      /no recover-rust-distribution action/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          mutation(
            workflow,
            'run: node scripts/rust-distribution.js publish-assets --tag "$RELEASE_TAG" --dir rust-release',
            'run: gh release upload "$RELEASE_TAG" rust-release/* --clobber'
          )
        ),
      /assets are not verified and uploaded without overwrite/
    );
  });
});

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
        tag: 'v6.10.3',
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
            tag: 'v6.10.3',
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

describe('Rust npm shim integration', function () {
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
