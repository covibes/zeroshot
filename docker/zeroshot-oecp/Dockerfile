# syntax=docker/dockerfile:1

# The server and the existing Node worker ship together because OECP is the
# in-capsule process boundary. Capsule allocation and termination remain owned
# by Zero Cloud's control plane and capsule agent.
FROM rust@sha256:14b9b5f47dcc6644d0f0c1b35a2c2c5d0124f67159aaee28a348627523459b55 AS rust-builder
# Security package revisions intentionally follow the pinned Alpine release repositories.
# hadolint ignore=DL3018
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY zeroshot-rust ./zeroshot-rust
RUN rustup component add --toolchain 1.96.0 rustfmt clippy \
    && cargo build --locked --release -p zeroshot-rust --bin zeroshot-oecp-server \
    && rustup default 1.96.0 \
    && rustup toolchain uninstall 1.96.1 1.97.0

FROM node@sha256:c2cc26d8f991c2db236ad51a61efee843c482372d6d22570787309d511694110 AS node-builder
ARG CODEX_VERSION=0.146.0
# Security package revisions intentionally follow the pinned Alpine release repositories.
# hadolint ignore=DL3018
RUN apk add --no-cache build-base python3
WORKDIR /opt/zeroshot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 node-pty \
    && npm install --global --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"
COPY . .

FROM node@sha256:c2cc26d8f991c2db236ad51a61efee843c482372d6d22570787309d511694110 AS runtime
ARG ZEROSHOT_MIN_DISK_GB=10
ENV ZEROSHOT_MIN_DISK_GB=${ZEROSHOT_MIN_DISK_GB}
# Security package revisions intentionally follow the pinned Alpine release repositories.
# hadolint ignore=DL3018
RUN apk add --no-cache bash build-base ca-certificates git github-cli openssl python3 tini \
    && install -d -m 1777 /tmp \
    && install -d -m 0750 -o node -g node /workspace
COPY --from=node-builder --chown=node:node /opt/zeroshot /opt/zeroshot
COPY --from=node-builder /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
COPY --from=rust-builder --chown=node:node /usr/local/cargo/bin /usr/local/cargo/bin
COPY --from=rust-builder --chown=node:node /usr/local/rustup /usr/local/rustup
COPY --from=rust-builder /build/target/release/zeroshot-oecp-server /usr/local/bin/zeroshot-oecp-server
RUN ln -s /opt/zeroshot/bin/zeroshot-cluster-worker.js /usr/local/bin/zeroshot-cluster-worker \
    && ln -s /opt/zeroshot/cli/index.js /usr/local/bin/zeroshot \
    && ln -s /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && for command in cargo cargo-clippy cargo-fmt clippy-driver rustc rustdoc rustfmt rustup; do \
        ln -s "/usr/local/cargo/bin/${command}" "/usr/local/bin/${command}"; \
    done
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:${PATH}
# The official Node image defines this stable application user.
# hadolint ignore=DL3066
USER node
WORKDIR /workspace
EXPOSE 8083 8084
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/zeroshot-oecp-server"]
