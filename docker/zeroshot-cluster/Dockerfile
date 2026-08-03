# Zeroshot cluster isolation image
# The OMP SDK lane is bundled from the repository shrinkwrap; no global `omp` or user OMP home
# is installed in this image.

FROM node:22-slim

ARG TARGETOS=linux
ARG TARGETARCH
ARG AWS_CLI_VERSION=2.15.10
ARG TERRAFORM_VERSION=1.6.6
ARG KUBECTL_VERSION=1.29.0
ARG HELM_VERSION=3.13.3
ARG INFRACOST_VERSION=0.10.32
ARG TFLINT_VERSION=0.50.0
ARG TFSEC_VERSION=1.28.4
ARG CLAUDE_CODE_VERSION=2.1.20
ARG BUN_RUNTIME_VERSION=1.3.14
ARG OMP_SDK_VERSION=17.2.1

LABEL org.opencontainers.image.title="zeroshot-cluster" \
      org.opencontainers.image.description="Zeroshot isolated coding runtime with pinned OMP SDK sidecar" \
      io.zeroshot.runtime.bun="${BUN_RUNTIME_VERSION}" \
      io.zeroshot.runtime.omp-sdk="${OMP_SDK_VERSION}"

# npm 11 keeps the Node 22 image toolchain reproducible and avoids the npm 10 Arborist crash.
RUN npm install -g npm@11

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
    python3-dev \
    ca-certificates \
    gnupg \
    unzip \
    util-linux \
    docker.io \
    docker-compose \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Every downloaded tool is selected by Docker's target architecture. Unsupported targets fail
# before any archive is installed rather than silently embedding an x64 binary.
RUN set -eux; \
    test "$TARGETOS" = linux; \
    case "$TARGETARCH" in \
      amd64) tool_arch=amd64; aws_arch=x86_64 ;; \
      arm64) tool_arch=arm64; aws_arch=aarch64 ;; \
      *) echo "unsupported cluster target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/aws; \
    curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tool_arch}.zip" -o /tmp/terraform.zip; \
    unzip -q /tmp/terraform.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/terraform; \
    rm /tmp/terraform.zip; \
    curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${tool_arch}/kubectl" -o /usr/local/bin/kubectl; \
    chmod +x /usr/local/bin/kubectl; \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${tool_arch}.tar.gz" -o /tmp/helm.tar.gz; \
    tar -xzf /tmp/helm.tar.gz -C /tmp; \
    mv "/tmp/linux-${tool_arch}/helm" /usr/local/bin/helm; \
    chmod +x /usr/local/bin/helm; \
    rm -rf /tmp/helm.tar.gz "/tmp/linux-${tool_arch}"; \
    curl -fsSL "https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-${tool_arch}.tar.gz" -o /tmp/infracost.tar.gz; \
    tar -xzf /tmp/infracost.tar.gz -C /tmp; \
    mv "/tmp/infracost-linux-${tool_arch}" /usr/local/bin/infracost; \
    chmod +x /usr/local/bin/infracost; \
    rm /tmp/infracost.tar.gz; \
    curl -fsSL "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_${tool_arch}.zip" -o /tmp/tflint.zip; \
    unzip -q /tmp/tflint.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/tflint; \
    rm /tmp/tflint.zip; \
    curl -fsSL "https://github.com/aquasecurity/tfsec/releases/download/v${TFSEC_VERSION}/tfsec-linux-${tool_arch}" -o /usr/local/bin/tfsec; \
    chmod +x /usr/local/bin/tfsec

ENV AWS_PAGER="" \
    CHROME_BIN=/usr/bin/chromium \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    ZEROSHOT_OMP_RUNTIME_ATTESTATION=/usr/local/share/zeroshot/omp-sdk-runtime.json

# npm-shrinkwrap.json is authoritative. Install only its production closure and run only the two
# native dependency rebuilds required by Zeroshot; root lifecycle scripts are deliberately skipped.
WORKDIR /opt/zeroshot
COPY --chown=node:node package.json package-lock.json npm-shrinkwrap.json ./
RUN cmp package-lock.json npm-shrinkwrap.json \
    && npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 node-pty
COPY --chown=node:node . ./
RUN node -e "const fs=require('fs');const crypto=require('crypto');const runtime=require('./scripts/omp-sdk-runtime');const lockSource=fs.readFileSync('package-lock.json','utf8');const shrinkSource=fs.readFileSync('npm-shrinkwrap.json','utf8');const result=runtime.validateOmpSdkReleaseAssets(require('./package.json'),JSON.parse(lockSource),{packageShrinkwrap:JSON.parse(shrinkSource),packageLockSource:lockSource,packageShrinkwrapSource:shrinkSource,sourceFiles:runtime.REQUIRED_OMP_SDK_SOURCES});const installed=runtime.resolveOmpSdkRuntime({packageRoot:'/opt/zeroshot'});const bun=require('./node_modules/bun/package.json');const omp=require('./node_modules/@oh-my-pi/pi-coding-agent/package.json');if(bun.version!=='${BUN_RUNTIME_VERSION}'||omp.version!=='${OMP_SDK_VERSION}')throw new Error('pinned SDK runtime version drift');const sidecarSha256=crypto.createHash('sha256').update(fs.readFileSync('./scripts/omp-sdk-sidecar.ts')).digest('hex');fs.mkdirSync('/usr/local/share/zeroshot',{recursive:true});fs.writeFileSync(process.env.ZEROSHOT_OMP_RUNTIME_ATTESTATION,JSON.stringify({...result,architecture:process.arch,bunExecutable:installed.bunExecutable,ompNativePlatformPackage:installed.ompNativePlatformPackage,sidecar:installed.sidecarPath,sidecarSha256,shrinkwrap:'/opt/zeroshot/npm-shrinkwrap.json'})+'\n',{mode:0o644});" \
    && test "$(./node_modules/bun/bin/bun.exe --version)" = "$BUN_RUNTIME_VERSION" \
    && npm link --ignore-scripts \
    && test ! -e /usr/local/bin/omp \
    && test ! -e /usr/bin/omp

COPY docker/zeroshot-cluster/pre-baked-deps.json /pre-baked-deps/package.json
RUN cd /pre-baked-deps && npm install --ignore-scripts \
    && chown -R node:node /pre-baked-deps

# Preserve explicit direct-provider image variants. OMP SDK itself is never installed globally.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
RUN groupadd -f docker && usermod -aG docker node
RUN mkdir -p /home/node/.claude /home/node/.config/gh /workspace \
    && chown -R node:node /home/node /workspace

ARG PROVIDER_INSTALL=""
RUN if [ -n "$PROVIDER_INSTALL" ]; then sh -c "$PROVIDER_INSTALL"; fi \
    && test ! -e /usr/local/bin/omp \
    && test ! -e /usr/bin/omp

WORKDIR /workspace
USER node

# Create a provider's config/overlay roots as the non-root container user (owner-only), so a
# provider whose credential surface is env/broker-only (no host mount) still gets a writable,
# private state directory. Registry-fed via PROVIDER_CONFIG_ROOTS (docker.configRoots); no
# provider name appears in this Dockerfile.
ARG PROVIDER_CONFIG_ROOTS=""
RUN if [ -n "$PROVIDER_CONFIG_ROOTS" ]; then for d in $PROVIDER_CONFIG_ROOTS; do mkdir -p "$d" && chmod 700 "$d"; done; fi

# Default command (overridden by vibe)
CMD ["bash"]
