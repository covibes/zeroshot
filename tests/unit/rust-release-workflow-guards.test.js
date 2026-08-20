const assert = require('assert');

const {
  distribution,
  mutation,
  nodeReleaseWorkflow,
  releaseWorkflow,
} = require('./rust-distribution-support');

function rejectsRustMutation(before, after, error) {
  assert.throws(
    () =>
      distribution.checkRepository(
        mutation(releaseWorkflow(), before, after),
        nodeReleaseWorkflow()
      ),
    error
  );
}

describe('Rust release workflow causal guards', function () {
  it('guards the exact source, independent tag, build matrix, and complete assets', function () {
    for (const [before, after, error] of [
      [
        'git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main',
        'echo skip-main-ancestry',
        /exact-source guard/,
      ],
      [
        'release_tag="zeroshot-rust-v$RELEASE_VERSION"',
        'release_tag="v$RELEASE_VERSION"',
        /exact-source guard/,
      ],
      [
        'run: node scripts/rust-distribution.js stage-version --tag "$RELEASE_TAG"',
        'run: echo skip-version-stage',
        /version staging/,
      ],
      [
        'run: cargo build --release --locked -p zeroshot-rust --bin zeroshot-rust --target ${{ matrix.target }}',
        'run: echo skip-native-build',
        /build step must execute exactly/,
      ],
      ['runner: macos-14', 'runner: ubuntu-latest', /matrix rows differs/],
      [
        'docker/zeroshot-rust-target/Dockerfile',
        'docker/zeroshot-v2-target/Dockerfile',
        /public Rust target Dockerfile/,
      ],
      [
        'docker image tag "$canonical" "$commit_ref"',
        'echo skip-commit-image-tag',
        /canonical image guard/,
      ],
      [
        'run: node scripts/rust-distribution.js publish-assets --tag "$RELEASE_TAG" --dir rust-release',
        'run: gh release upload "$RELEASE_TAG" rust-release/* --clobber',
        /assets are not verified/,
      ],
      ['--latest=false', '--latest=true', /must not replace the Node release as Latest/],
    ]) {
      rejectsRustMutation(before, after, error);
    }
  });

  it('keeps dry-run inputs non-publishing and the npm shim independently recoverable', function () {
    rejectsRustMutation('          - dry-run\n', '', /Rust release actions/);
    rejectsRustMutation(
      "if: inputs.action == 'publish-npm-shim' && needs.rust-shim-input.result == 'success'",
      "if: inputs.action == 'release'",
      /separate OIDC-authorized action/
    );
    rejectsRustMutation(
      '      contents: read\n    env:\n      RELEASE_COMMIT: ${{ needs.plan.outputs.commit }}',
      '      contents: read\n      packages: write\n    env:\n      RELEASE_COMMIT: ${{ needs.plan.outputs.commit }}',
      /dry-run input job must not receive publication authority/
    );
    rejectsRustMutation(
      'registry_integrity="$(npm view "$package" dist.integrity)"',
      'registry_integrity="$local_integrity"',
      /idempotently recoverable/
    );
    rejectsRustMutation(
      '$install_root/node_modules/.bin/zeroshot-rust',
      '$install_root/bin/zeroshot-rust',
      /exact packed tarball/
    );
  });

  it('keeps the Node semantic-release train free of Rust dependencies', function () {
    const coupled = mutation(
      nodeReleaseWorkflow(),
      'needs: [install-matrix, release-plan]',
      'needs: [install-matrix, release-plan, rust-manifest]'
    );
    assert.throws(
      () => distribution.checkRepository(releaseWorkflow(), coupled),
      /Node release retains Rust coupling|Node release dependencies/
    );
  });
});
