FROM docker.io/library/rust:1.97-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa AS rust-build
WORKDIR /opt/zeroshot
COPY Cargo.toml Cargo.lock rust-toolchain.toml clippy.toml ./
COPY crates ./crates
COPY zeroshot-rust/Cargo.toml ./zeroshot-rust/Cargo.toml
COPY zeroshot-rust/src ./zeroshot-rust/src
RUN cargo build --locked --release -p zeroshot-rust --bin zeroshot-oecp-server

FROM docker.io/library/node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS node-deps
WORKDIR /opt/node-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY docker/zeroshot-oecp/package.json docker/zeroshot-oecp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 node-pty --build-from-source --no-audit --no-fund \
    && npm install brace-expansion@5.0.9 undici@8.9.0 --no-save --ignore-scripts --no-audit --no-fund \
    && cp -r node_modules/brace-expansion/. node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/ \
    && rm -rf node_modules/@earendil-works/pi-coding-agent/node_modules/undici \
    && cp -r node_modules/undici node_modules/@earendil-works/pi-coding-agent/node_modules/undici \
    && rm -rf node_modules/brace-expansion node_modules/undici \
    && node -e "const pkg = require( \
      './node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json'); \
      if (pkg.version !== '5.0.9') throw new Error('expected brace-expansion@5.0.9, got ' + pkg.version)" \
    && node -e "const pkg = require( \
      './node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json'); \
      if (pkg.version !== '8.9.0') throw new Error('expected undici@8.9.0, got ' + pkg.version)"

FROM docker.io/instructure/tini:v0.19.0@sha256:0f9ccf2e54d010735ad691ebe670e256a3820fe8b92c28101194c68ee1216092 AS tini

FROM docker.io/library/node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f -- /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && rm -rf -- /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /opt/yarn-v1.22.22
LABEL org.opencontainers.image.title="zeroshot-oecp-private" \
      org.opencontainers.image.description="Unpublished legacy single-worker capsule runtime" \
      org.opencontainers.image.version="private" \
      io.openengine.private="true" \
      io.openengine.graph-profile="openengine.graph.single-worker/v1" \
      io.openengine.worker-profile="legacy.zeroshot.ship@1" \
      io.openengine.limitation="bounded Node worker; not native-v2 or full-v1"

COPY --from=rust-build /opt/zeroshot/target/release/zeroshot-oecp-server /usr/local/bin/zeroshot-oecp-server
COPY --from=node-deps /opt/node-runtime/node_modules /opt/zeroshot/node_modules
COPY --from=tini /tini /usr/bin/tini
COPY package.json /opt/zeroshot/package.json
COPY cli /opt/zeroshot/cli
COPY cluster-hooks /opt/zeroshot/cluster-hooks
COPY cluster-templates /opt/zeroshot/cluster-templates
COPY lib /opt/zeroshot/lib
COPY src /opt/zeroshot/src
COPY task-lib /opt/zeroshot/task-lib
COPY scripts/omp/runtime.js scripts/omp/runtime-identities.js scripts/omp/runtime-lock.js scripts/omp/runtime-release.js /opt/zeroshot/scripts/omp/
COPY src/command-cleanup-ownership.js src/omp-config-overlay.js src/worktree-claude-config.js src/worktree-tooling-env.js /opt/zeroshot/src/
COPY protocol/openengine-cluster/v1/worker.schema.json /opt/zeroshot/protocol/openengine-cluster/v1/worker.schema.json
COPY zeroshot-rust/hosted-node /opt/zeroshot/zeroshot-rust/hosted-node

RUN groupadd --gid 10002 zeroshot-worker \
    && useradd --uid 10002 --gid 10002 --home-dir /tmp/zeroshot-oecp --no-create-home --shell /usr/sbin/nologin zeroshot-worker \
    && rm -rf /opt/zeroshot/src/target \
    && chmod -R a+rX /opt/zeroshot/cli /opt/zeroshot/cluster-hooks \
        /opt/zeroshot/cluster-templates /opt/zeroshot/lib /opt/zeroshot/protocol \
        /opt/zeroshot/scripts /opt/zeroshot/src /opt/zeroshot/task-lib \
        /opt/zeroshot/zeroshot-rust/hosted-node \
    && mkdir -p /workspace /tmp/zeroshot-oecp /run/zeroshot-capsule-agent \
    && chown 10002:10002 /workspace \
    && chown 0:10002 /run/zeroshot-capsule-agent \
    && chown 10002:10002 /tmp/zeroshot-oecp \
    && chmod 0770 /workspace \
    && chmod 0700 /tmp/zeroshot-oecp /run/zeroshot-capsule-agent \
    && chmod 0755 /usr/bin/tini \
    && chmod 0555 /opt/zeroshot/cli/index.js \
    && chmod 0555 /opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js \
    && ln -s /opt/zeroshot/cli/index.js /usr/local/bin/zeroshot \
    && test -x /usr/bin/git \
    && test -x /usr/local/bin/zeroshot \
    && test ! -e /usr/bin/gh

ENV ZEROSHOT_OECP_CAPABILITY_FILE=/run/zeroshot-capsule-agent/capability
ENV PATH=/opt/zeroshot/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 0:10002
WORKDIR /workspace
EXPOSE 8083 8084 8085
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["/usr/local/bin/zeroshot-oecp-server", "--healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/node", "/opt/zeroshot/zeroshot-rust/hosted-node/capsule-entrypoint.js"]
