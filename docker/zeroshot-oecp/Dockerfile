# syntax=docker/dockerfile:1

# The server and the existing Node worker ship together because OECP is the
# in-capsule process boundary. Capsule allocation and termination remain owned
# by Zero Cloud's runner/agent sidecars.
FROM lukemathwalker/cargo-chef@sha256:4a51277f4e3e8e4643dd6384f6f6b2b3c8de9f074299cd0c19a80f3c29e8dd15 AS rust-builder
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY zeroshot-rust ./zeroshot-rust
RUN cargo build --locked --release -p zeroshot-rust --bin zeroshot-oecp-server

FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS node-builder
ARG CODEX_VERSION=0.146.0
# Debian security package revisions intentionally follow the pinned base image's repositories.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/zeroshot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 node-pty \
    && npm install --global --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"
COPY . .

FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
ARG ZEROSHOT_MIN_DISK_GB=10
ENV ZEROSHOT_MIN_DISK_GB=${ZEROSHOT_MIN_DISK_GB}
# Debian security package revisions intentionally follow the pinned base image's repositories.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git gh tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 1777 /tmp \
    && install -d -m 0750 -o node -g node /workspace
COPY --from=node-builder --chown=node:node /opt/zeroshot /opt/zeroshot
COPY --from=node-builder /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
COPY --from=rust-builder /build/target/release/zeroshot-oecp-server /usr/local/bin/zeroshot-oecp-server
RUN ln -s /opt/zeroshot/bin/zeroshot-cluster-worker.js /usr/local/bin/zeroshot-cluster-worker \
    && ln -s /opt/zeroshot/cli/index.js /usr/local/bin/zeroshot \
    && ln -s /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
USER node
WORKDIR /workspace
EXPOSE 8083 8084
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zeroshot-oecp-server"]
