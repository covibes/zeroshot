# `@the-open-engine/zeroshot-rust`

Thin installer for the standalone `zeroshot-rust` executable. The package selects the release archive for the current Node platform and architecture, verifies it against that release's `SHA256SUMS`, and installs only the verified executable.

Installation fails closed with `UNSUPPORTED_ZEROSHOT_RUST_HOST` when the host has no declared release target. It never falls back to the Node Zeroshot package, source compilation, or a binary for another target.

Supported hosts are Linux x64/arm64, macOS x64/arm64, and Windows x64.
