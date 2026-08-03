const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  mutation,
  mutateWorkflowJob,
  projectRoot,
  relativeFiles,
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
  it('causally guards build, matrix, upload, publication, recovery, and shim integrity', function () {
    const workflow = fs.readFileSync(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    assert.strictEqual(distribution.checkRepository(workflow), true);

    for (const [jobName, installName, installCommand] of [
      ['dry-run', 'Install pinned dependencies', 'npm ci'],
      ['release', 'Install pinned dependencies', 'npm ci'],
      ['rust-binaries', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
      ['rust-manifest', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
      ['rust-publish', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
    ]) {
      const mutateInstall = (mutateJob) => mutateWorkflowJob(workflow, jobName, mutateJob);
      assert.throws(
        () =>
          distribution.checkRepository(
            mutateInstall((job) => {
              job.steps.find((step) => step.name === installName).run =
                `${installCommand} --foreground-scripts`;
            })
          ),
        new RegExp(`${jobName} dependency install must execute at workspace root`)
      );
      assert.throws(
        () =>
          distribution.checkRepository(
            mutateInstall((job) => {
              job.steps = job.steps.filter((step) => step.name !== installName);
            })
          ),
        new RegExp(installName)
      );
      assert.throws(
        () =>
          distribution.checkRepository(
            mutateInstall((job) => {
              const installIndex = job.steps.findIndex((step) => step.name === installName);
              const [install] = job.steps.splice(installIndex, 1);
              const invocationIndex = job.steps.findIndex((step) =>
                step.run?.includes('scripts/rust-distribution.js')
              );
              job.steps.splice(invocationIndex + 1, 0, install);
            })
          ),
        new RegExp(`${jobName} must install dependencies before every`)
      );
      for (const command of [
        'node ./scripts/rust-distribution.js print-version',
        './scripts/rust-distribution.js print-version',
        'node "scripts/rust-distribution.js" print-version',
        "node 'scripts/rust-distribution.js' print-version",
        'node "./scripts/rust-distribution.js" print-version',
        "node './scripts/rust-distribution.js' print-version",
        '"scripts/rust-distribution.js" print-version',
        "'scripts/rust-distribution.js' print-version",
        '"./scripts/rust-distribution.js" print-version',
        "'./scripts/rust-distribution.js' print-version",
      ]) {
        assert.throws(
          () =>
            distribution.checkRepository(
              mutateInstall((job) => {
                job.steps.unshift({
                  name: 'Invoke Rust distribution before dependency installation',
                  run: command,
                });
              })
            ),
          new RegExp(`${jobName} must install dependencies before every`)
        );
      }
      for (const mutateCheckout of [
        (checkout) => {
          checkout.if = false;
        },
        (checkout) => {
          checkout.with.path = 'nested';
        },
        (checkout) => {
          checkout.with.repository = 'other/repository';
        },
        (checkout) => {
          checkout.with.ref = 'main';
        },
      ]) {
        assert.throws(
          () =>
            distribution.checkRepository(
              mutateInstall((job) => {
                const checkout = job.steps.find((step) =>
                  step.uses?.startsWith('actions/checkout@')
                );
                mutateCheckout(checkout);
              })
            ),
          new RegExp(`${jobName} must checkout expected current repository source`)
        );
      }
      for (const mutateNodeSetup of [
        (job, setup) => {
          job.steps = job.steps.filter((step) => step !== setup);
        },
        (_job, setup) => {
          setup.if = false;
        },
        (_job, setup) => {
          setup.with.cache = '';
        },
        (_job, setup) => {
          setup.with['node-version'] = 20;
        },
        (job, setup) => {
          const setupIndex = job.steps.indexOf(setup);
          job.steps.splice(setupIndex, 1);
          const installIndex = job.steps.findIndex((step) => step.name === installName);
          job.steps.splice(installIndex + 1, 0, setup);
        },
      ]) {
        assert.throws(
          () =>
            distribution.checkRepository(
              mutateInstall((job) => {
                const setup = job.steps.find((step) =>
                  step.uses?.startsWith('actions/setup-node@')
                );
                mutateNodeSetup(job, setup);
              })
            ),
          new RegExp(`${jobName} must enable pinned Node 24 npm cache`)
        );
      }
      assert.throws(
        () =>
          distribution.checkRepository(
            mutateInstall((job) => {
              job.steps.find((step) => step.name === installName)['working-directory'] = 'nested';
            })
          ),
        new RegExp(`${jobName} dependency install must execute at workspace root`)
      );
      assert.throws(
        () =>
          distribution.checkRepository(
            mutateInstall((job) => {
              const installIndex = job.steps.findIndex((step) => step.name === installName);
              const [install] = job.steps.splice(installIndex, 1);
              const checkoutIndex = job.steps.findIndex((step) =>
                step.uses?.startsWith('actions/checkout@')
              );
              job.steps.splice(checkoutIndex, 0, install);
            })
          ),
        new RegExp(`${jobName} must checkout source before dependency installation`)
      );
    }

    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    const packageWithoutYaml = JSON.parse(JSON.stringify(packageManifest));
    delete packageWithoutYaml.devDependencies['js-yaml'];
    assert.throws(
      () => distribution.checkRepository(workflow, undefined, packageWithoutYaml),
      /direct js-yaml devDependency/
    );

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    );
    const mutatePackageLock = (mutateLock) => {
      const candidate = JSON.parse(JSON.stringify(packageLock));
      mutateLock(candidate);
      return candidate;
    };
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow,
          undefined,
          packageManifest,
          mutatePackageLock((candidate) => {
            delete candidate.packages[''].devDependencies['js-yaml'];
          })
        ),
      /package-lock root js-yaml spec must match/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow,
          undefined,
          packageManifest,
          mutatePackageLock((candidate) => {
            candidate.packages[''].devDependencies['js-yaml'] = '^9.0.0';
          })
        ),
      /package-lock root js-yaml spec must match/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow,
          undefined,
          packageManifest,
          mutatePackageLock((candidate) => {
            delete candidate.packages['node_modules/js-yaml'];
          })
        ),
      /integrity-pinned resolved js-yaml/
    );
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow,
          undefined,
          packageManifest,
          mutatePackageLock((candidate) => {
            delete candidate.packages['node_modules/js-yaml'].integrity;
          })
        ),
      /integrity-pinned resolved js-yaml/
    );
    for (const mutateResolution of [
      (candidate) => {
        candidate.packages['node_modules/js-yaml'].version = '';
      },
      (candidate) => {
        candidate.packages['node_modules/js-yaml'].resolved = ' ';
      },
      (candidate) => {
        candidate.packages['node_modules/js-yaml'].integrity = 'sha512-';
      },
      (candidate) => {
        candidate.packages['node_modules/js-yaml'].integrity = 'sha512-YQ==';
      },
    ]) {
      assert.throws(
        () =>
          distribution.checkRepository(
            workflow,
            undefined,
            packageManifest,
            mutatePackageLock(mutateResolution)
          ),
        /integrity-pinned resolved js-yaml/
      );
    }

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

  it('keeps native release metadata outside the private product and public Node package', function () {
    const rustRoot = path.join(projectRoot, 'zeroshot-rust');
    const privateHostedNodeFiles = new Set([
      'hosted-node/engine-adapter.js',
      'hosted-node/worker.js',
      'hosted-node/workspace-tools.js',
    ]);
    for (const file of relativeFiles(rustRoot)) {
      assert(
        file === 'Cargo.toml' || file.endsWith('.rs') || privateHostedNodeFiles.has(file),
        `unexpected product file: ${file}`
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
      '!docker/zeroshot-oecp/',
      'scripts/',
      '!scripts/hosted-oecp-image.js',
      '!scripts/hosted-oecp-image-commands.js',
      '!scripts/hosted-oecp-image-smoke.js',
      '!scripts/hosted-oecp-manifest.js',
      '!scripts/hosted-oecp-smoke-capability.js',
      '!scripts/hosted-oecp-smoke-client.js',
      '!scripts/hosted-oecp-smoke-fixture.js',
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
