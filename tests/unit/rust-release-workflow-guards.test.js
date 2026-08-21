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
        'readelf --program-headers "$BINARY_PATH"',
        'echo skip-static-linux-check',
        /statically portable/,
      ],
      [
        'echo "RUSTFLAGS=-C link-arg=-lgcc" >> "$GITHUB_ENV"',
        'echo skip-static-gcc-runtime',
        /static C toolchain/,
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
});

describe('Rust npm shim release guards', function () {
  it('keeps dry-run non-publishing and finishes releases with a recoverable npm shim', function () {
    rejectsRustMutation('          - dry-run\n', '', /Rust release actions/);
    rejectsRustMutation(
      '  rust-shim-publish:\n    needs: [plan, rust-image-publish, rust-shim-input]\n    if: |\n      always() &&\n',
      '  rust-shim-publish:\n    needs: [plan, rust-image-publish, rust-shim-input]\n    if: |\n      !always() &&\n',
      /final OIDC-authorized release step/
    );
    rejectsRustMutation(
      "      needs.rust-image-publish.result == 'success' &&\n",
      '',
      /final OIDC-authorized release step/
    );
    rejectsRustMutation(
      "      needs.rust-shim-input.result == 'success'\n",
      "      needs.rust-shim-input.result == 'failure'\n",
      /final OIDC-authorized release step/
    );
    rejectsRustMutation(
      "      needs.rust-manifest.result == 'success' &&\n",
      '',
      /dry-run and complete release/
    );
    rejectsRustMutation(
      "        if: inputs.action == 'release'\n        env:\n          GH_TOKEN: ${{ github.token }}",
      "        if: inputs.action == 'dry-run'\n        env:\n          GH_TOKEN: ${{ github.token }}",
      /published GitHub assets/
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
    rejectsRustMutation(
      'tarballs=(./shim-release/*.tgz)',
      'tarballs=(shim-release/*.tgz)',
      /exact packed tarball/
    );
    rejectsRustMutation(
      'npm install --ignore-scripts --prefix "$install_root" "${tarballs[0]}"',
      'npm install --ignore-scripts --prefix "$install_root" ./npm/zeroshot-rust',
      /exact packed tarball/
    );
    rejectsRustMutation(
      'npm publish --dry-run --access public ./shim-release/*.tgz',
      'npm publish --dry-run --access public shim-release/*.tgz',
      /exact local tarball/
    );
    rejectsRustMutation(
      'npm publish --provenance --access public ./shim-release/*.tgz',
      'npm publish --provenance --access public shim-release/*.tgz',
      /idempotently recoverable/
    );
  });
});

describe('Rust and Node release isolation', function () {
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
