# Zeroshot Rust distribution

Zeroshot Rust is released independently from the Node product. Its release is an explicit manual
operation in `release-rust.yml`: the operator supplies an `X.Y.Z` version and an exact commit on
`main`. `dry-run` builds the same publication inputs without publish authority; `release` publishes
the complete distribution. The initial release is `0.1.0`.

The canonical release consists of:

- an immutable `zeroshot-rust-vX.Y.Z` tag and non-latest GitHub Release;
- one native archive per target declared by `distribution/zeroshot-rust-targets.json`, plus a
  complete `SHA256SUMS`;
- the Linux AMD64 image `ghcr.io/the-open-engine/zeroshot-rust-target`, tagged with the version,
  full commit SHA, and `latest`;
- the `@the-open-engine/zeroshot-rust` npm downloader shim.

The npm package contains only a downloader shim. The release verifies the published checksums and
archives, packs the shim, and publishes that exact Rust version after the image passes anonymous
installation. Installation selects the host archive and verifies its SHA-256 before extraction.
Unsupported hosts fail instead of building from source or falling back to Node.

Release staging writes the requested version into the temporary Cargo and npm workspaces; it never
commits versions to `main`. Rerunning the release with the same version and commit is the
recovery path. Existing Git tags, release assets, and npm versions fail closed on conflicting
content. Existing version/SHA images are source-verified and reused as the canonical recovery image;
missing tags are filled from that image. Historical combined releases remain unchanged. Publishing
the shim requires npm trusted publishing for `release-rust.yml`.

GHCR creates a new container package as private. After the first image push, an organization owner
must set `zeroshot-rust-target` to public. That first workflow run may stop at its anonymous-pull
check; rerunning the same version and commit completes recovery and verifies public installation.

The Node release remains automatic and owns `vX.Y.Z`, the repository-wide GitHub “Latest” marker,
and `@the-open-engine/zeroshot`. Rust-only commits are excluded from Node version analysis and
generated Node release notes.
