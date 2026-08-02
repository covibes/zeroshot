# Base image for vibe cluster isolation mode
# Provides: Node.js, Python, Git, Chromium, Claude CLI, Playwright deps, Infrastructure tools
#
# Build: docker build -t vibe-cluster-base vibe/cluster/docker/vibe-cluster/
# Usage: zeroshot run <task> --docker

FROM node:20-slim

# Upgrade npm to fix Arborist isDescendantOf bug (npm 10.x crash on complex peer deps)
# See: https://github.com/npm/cli/issues/7682
# Pinned to npm@11 (the latest line that still supports the node:20-slim base); npm@latest (12.x)
# now requires node >=22 and breaks the build with EBADENGINE.
RUN npm install -g npm@11

# Version pinning for infrastructure tools
ARG AWS_CLI_VERSION=2.15.10
ARG TERRAFORM_VERSION=1.6.6
ARG KUBECTL_VERSION=1.29.0
ARG HELM_VERSION=3.13.3
ARG INFRACOST_VERSION=0.10.32
ARG TFLINT_VERSION=0.50.0
ARG TFSEC_VERSION=1.28.4
ARG CLAUDE_CODE_VERSION=2.1.20

# Install system dependencies for e2e testing and development
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    # Build tools for native modules (node-gyp needs make, gcc, g++)
    build-essential \
    python3-dev \
    ca-certificates \
    gnupg \
    unzip \
    # Docker for starting services
    docker.io \
    docker-compose \
    # Python for general development
    python3 \
    python3-pip \
    python3-venv \
    # Chromium dependencies
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
    # Create python symlink for compatibility
    && ln -sf /usr/bin/python3 /usr/bin/python

# Install GitHub CLI for git authentication
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install infrastructure tools
# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Terraform
RUN curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -o /tmp/terraform.zip \
    && unzip -q /tmp/terraform.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/terraform \
    && rm /tmp/terraform.zip

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Helm
RUN curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" -o /tmp/helm.tar.gz \
    && tar -xzf /tmp/helm.tar.gz -C /tmp \
    && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
    && chmod +x /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

# infracost (cost estimation)
RUN curl -fsSL "https://github.com/infracost/infracost/releases/download/v${INFRACOST_VERSION}/infracost-linux-amd64.tar.gz" -o /tmp/infracost.tar.gz \
    && tar -xzf /tmp/infracost.tar.gz -C /tmp \
    && mv /tmp/infracost-linux-amd64 /usr/local/bin/infracost \
    && chmod +x /usr/local/bin/infracost \
    && rm /tmp/infracost.tar.gz

# tflint (terraform linter)
RUN curl -fsSL "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_amd64.zip" -o /tmp/tflint.zip \
    && unzip -q /tmp/tflint.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/tflint \
    && rm /tmp/tflint.zip

# tfsec (security scanner)
RUN curl -fsSL "https://github.com/aquasecurity/tfsec/releases/download/v${TFSEC_VERSION}/tfsec-linux-amd64" -o /usr/local/bin/tfsec \
    && chmod +x /usr/local/bin/tfsec

# Set AWS_PAGER to empty to disable paging in AWS CLI
ENV AWS_PAGER=""

# Set Chromium path for Playwright
ENV CHROME_BIN=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Copy zeroshot source into container and install globally
# CRITICAL: This enables isolation mode to use 'zeroshot task run' inside container
# which provides timeout, error handling, and log streaming infrastructure
COPY --chown=node:node . /tmp/zeroshot/
RUN cd /tmp/zeroshot && npm install && npm link

# Pre-bake common npm dependencies (Issue #20: 30-40% startup reduction)
# These are installed once at image build time, then copied to workspaces at runtime
# if the project's dependencies are satisfied by the pre-baked set.
COPY docker/zeroshot-cluster/pre-baked-deps.json /pre-baked-deps/package.json
RUN cd /pre-baked-deps && npm install --ignore-scripts \
    && chown -R node:node /pre-baked-deps

# Install Claude CLI globally (version pinned via ARG)
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install Playwright (uses system Chromium)
RUN npx playwright install-deps chromium 2>/dev/null || true

# Add node user to docker group for Docker socket access
RUN groupadd -f docker && usermod -aG docker node

# Use existing 'node' user from base image (uid 1000)
# Create directories with proper ownership for Claude CLI
RUN mkdir -p /home/node/.claude /home/node/.config/gh \
    && chown -R node:node /home/node

# Create workspace directory with node ownership
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

# Install the running provider's CLI as a docker-cached layer (per-provider image variant).
# Claude is baked in above, so its variant passes an empty PROVIDER_INSTALL and skips this step.
# Kept last in the root phase so every heavy layer above is shared across all provider images;
# Docker caches this layer keyed on the install command, so it builds once per provider and is
# then reused. The command comes from the provider registry (docker.install), never hardcoded.
ARG PROVIDER_INSTALL=""
RUN if [ -n "$PROVIDER_INSTALL" ]; then sh -c "$PROVIDER_INSTALL"; fi

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Create a provider's config/overlay roots as the non-root container user (owner-only), so a
# provider whose credential surface is env/broker-only (no host mount) still gets a writable,
# private state directory. Registry-fed via PROVIDER_CONFIG_ROOTS (docker.configRoots); no
# provider name appears in this Dockerfile.
ARG PROVIDER_CONFIG_ROOTS=""
RUN if [ -n "$PROVIDER_CONFIG_ROOTS" ]; then for d in $PROVIDER_CONFIG_ROOTS; do mkdir -p "$d" && chmod 700 "$d"; done; fi

# Default command (overridden by vibe)
CMD ["bash"]
