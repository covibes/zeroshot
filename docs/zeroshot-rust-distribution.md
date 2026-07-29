# Zeroshot Rust distribution decision

## Decision

The v1 standalone Rust product is distributed as prebuilt, per-target archives attached to the GitHub Release created by semantic-release. `distribution/zeroshot-rust-targets.json` is the authoritative platform/architecture list. Each archive contains only `zeroshot-rust` (`zeroshot-rust.exe` on Windows), and the release has one `SHA256SUMS` manifest covering every declared archive.

The separate `@the-open-engine/zeroshot-rust` npm package is a thin installer and launcher. Its postinstall selects the exact host target, downloads that release's manifest and archive, verifies SHA-256 before extraction, and atomically installs the executable. An undeclared platform/architecture fails installation with `UNSUPPORTED_ZEROSHOT_RUST_HOST`; there is no source-build, foreign-target, or Node fallback.

Release jobs build and run the empty binary natively on each target runner before packaging it. Manual workflow dispatch exercises the same complete build/archive/checksum path without downloading or publishing assets. Automatic publication remains guarded by `RELEASE_AUTOMATION_ENABLED`.

The automatic path resolves the semantic-release version, enforces Cargo coupling, and completes all five native builds, executable smoke checks, archives, and the aggregate checksum artifact before semantic-release may publish the root npm package, tag, or GitHub Release. After the tag exists, asset attachment is idempotent (`--clobber`) and shim publication first checks the registry for the exact version. A failed post-tag step can be retried directly, or `recover-rust-distribution` can rebuild from an explicitly supplied immutable `release_tag`/`release_commit` pair after verifying that the tag resolves to that commit and the commit is an ancestor of `main`.

## Version coupling

The semantic-release tag is the released product version and archive namespace. Before any target build, `scripts/rust-distribution.js check-version --tag vX.Y.Z` requires the `[package]` version in `zeroshot-rust/Cargo.toml` to equal `X.Y.Z`. Failure is named `RUST_VERSION_MISMATCH` and reports both values. Release-producing changes must therefore update the Cargo package version to the semantic-release version; the checked-in root npm version remains `0.0.0-development` under the existing semantic-release convention. The shim package is staged with that same tag version immediately before its guarded publication.

## Rejected mechanisms

- **crates.io for v1:** `zeroshot-rust` depends on the workspace-path packages `openengine-cluster-protocol` and `openengine-cluster-server`. Publishing it would first require converting and publishing those packages with registry versions, which is outside this release mechanism.
- **Binaries inside `@the-open-engine/zeroshot`:** bundling all five native artifacts in the existing Node package would impose the full platform matrix and package-size cost on every Node installation. It would also couple two products whose behavior and migration remain intentionally independent.
- **Third-party package managers:** Homebrew, apt, Scoop, signing, and notarization are separate future distribution concerns and are not part of v1.
