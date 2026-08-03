FROM docker.io/library/rust:1.97-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa AS rust-build
WORKDIR /opt/zeroshot
COPY Cargo.toml Cargo.lock rust-toolchain.toml clippy.toml ./
COPY crates ./crates
COPY zeroshot-rust/Cargo.toml ./zeroshot-rust/Cargo.toml
COPY zeroshot-rust/src ./zeroshot-rust/src
RUN cargo build --locked --release -p zeroshot-rust --bin zeroshot-oecp-server

FROM docker.io/library/node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS node-deps
WORKDIR /opt/node-runtime
COPY docker/zeroshot-oecp/package.json docker/zeroshot-oecp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM docker.io/instructure/tini:v0.19.0@sha256:0f9ccf2e54d010735ad691ebe670e256a3820fe8b92c28101194c68ee1216092 AS tini

FROM docker.io/library/node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime
ARG BUILD_MANIFEST_DIGEST
LABEL org.opencontainers.image.title="zeroshot-oecp-private" \
      org.opencontainers.image.description="Unpublished legacy single-worker capsule runtime" \
      org.opencontainers.image.version="private" \
      org.opencontainers.image.revision="${BUILD_MANIFEST_DIGEST}" \
      io.openengine.private="true" \
      io.openengine.graph-profile="openengine.graph.single-worker/v1" \
      io.openengine.worker-profile="legacy.zeroshot.ship@1" \
      io.openengine.limitation="bounded Node worker; not native-v2 or full-v1 certified"

COPY --from=rust-build /opt/zeroshot/target/release/zeroshot-oecp-server /usr/local/bin/zeroshot-oecp-server
COPY --from=node-deps /opt/node-runtime/node_modules /opt/zeroshot/node_modules
COPY --from=tini /tini /usr/bin/tini
COPY lib/cluster-worker/contracts.js lib/cluster-worker/engine-adapter-common.js lib/cluster-worker/engine-start.js /opt/zeroshot/lib/cluster-worker/
COPY lib/cluster-worker/executable.js lib/cluster-worker/index.js /opt/zeroshot/lib/cluster-worker/
COPY lib/cluster-worker/object-utils.js lib/cluster-worker/profiles.js lib/cluster-worker/runtime-engine.js /opt/zeroshot/lib/cluster-worker/
COPY lib/cluster-worker/runtime-support.js lib/cluster-worker/state-machine.js /opt/zeroshot/lib/cluster-worker/
COPY lib/cluster-worker/terminal-normalizer.js lib/cluster-worker/worker-internals.js /opt/zeroshot/lib/cluster-worker/
COPY lib/cluster-worker/runtime-dependencies.js /opt/zeroshot/lib/cluster-worker/runtime-dependencies.js
COPY lib/run-plan.js /opt/zeroshot/lib/run-plan.js
COPY protocol/openengine-cluster/v1/worker.schema.json /opt/zeroshot/protocol/openengine-cluster/v1/worker.schema.json
COPY zeroshot-rust/hosted-node /opt/zeroshot/zeroshot-rust/hosted-node

RUN groupadd --gid 10002 zeroshot-worker \
    && useradd --uid 10002 --gid 10002 --home-dir /tmp/zeroshot-oecp --no-create-home --shell /usr/sbin/nologin zeroshot-worker \
    && mkdir -p /workspace /tmp/zeroshot-oecp /run/zeroshot-capsule-agent \
    && chown 1000:10002 /workspace /run/zeroshot-capsule-agent \
    && chown 10002:10002 /tmp/zeroshot-oecp \
    && chmod 0770 /workspace \
    && chmod 0700 /tmp/zeroshot-oecp /run/zeroshot-capsule-agent \
    && chmod 0755 /usr/bin/tini \
    && test ! -e /usr/bin/git \
    && test ! -e /usr/bin/gh

ENV ZEROSHOT_OECP_CAPABILITY_FILE=/run/zeroshot-capsule-agent/capability
USER 0:0
WORKDIR /workspace
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["/usr/local/bin/zeroshot-oecp-server", "--healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/zeroshot-oecp-server"]
