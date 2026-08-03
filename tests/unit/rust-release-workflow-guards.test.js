const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  mutation,
  projectRoot,
  releaseWorkflow,
} = require('./rust-distribution-support');

function assertBuildAndUploadGuards(workflow) {
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
}

describe('Rust release workflow causal guards', function () {
  it('causally guards build, matrix, upload, publication, recovery, and shim integrity', function () {
    const workflow = releaseWorkflow();
    assertBuildAndUploadGuards(workflow);
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
