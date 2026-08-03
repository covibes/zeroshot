const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  projectRoot,
  relativeFiles,
  shim,
  temporaryDirectory,
} = require('./rust-distribution-support');

function registerShimInstallTests() {
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
}

function registerNativeMetadataTest() {
  it('keeps native metadata outside the Rust-only product and the Node package', function () {
    const rustRoot = path.join(projectRoot, 'zeroshot-rust');
    for (const file of relativeFiles(rustRoot)) {
      assert(
        file === 'Cargo.toml' ||
          file.endsWith('.rs') ||
          file === 'hosted-node/engine-adapter.js' ||
          file === 'hosted-node/workspace-tools.js' ||
          file === 'hosted-node/worker.js',
        `unexpected product file outside the private hosted adapter: ${file}`
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
      '!src/target/register-hosted-commands.ts',
      '!lib/target/register-hosted-commands.js',
      '!lib/target/register-hosted-commands.d.ts',
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
}

describe('Rust npm shim integration', function () {
  registerShimInstallTests();
  registerNativeMetadataTest();
});
