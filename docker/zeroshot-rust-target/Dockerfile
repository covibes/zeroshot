FROM rust:1.97.0-bookworm AS builder

WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY zeroshot-rust ./zeroshot-rust

RUN cargo build --locked --release --package zeroshot-rust --bin zeroshot-rust

FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.148.0
ARG CLAUDE_CODE_VERSION=2.1.237
ARG ZEROSHOT_RUST_VERSION=development
ARG VCS_REF=unknown

LABEL org.opencontainers.image.source="https://github.com/the-open-engine/zeroshot" \
      org.opencontainers.image.title="Zeroshot Rust target" \
      org.opencontainers.image.version="${ZEROSHOT_RUST_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        gh \
        git \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund \
        "@openai/codex@${CODEX_VERSION}" \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

COPY --from=builder /src/target/release/zeroshot-rust /usr/local/bin/zeroshot-rust

# The native runtime deliberately retains root so it can isolate node processes.
# Root owns target state; execute-only access lets isolated run UIDs reach their own workspaces.
RUN install -d -m 0711 /var/lib/zeroshot/native-v2

VOLUME ["/var/lib/zeroshot/native-v2"]
EXPOSE 8080

ENTRYPOINT ["zeroshot-rust"]
CMD ["target", "serve", "--listen", "0.0.0.0:8080", "--public-origin", "http://127.0.0.1:8080", "--storage", "/var/lib/zeroshot/native-v2"]
