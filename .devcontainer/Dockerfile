# syntax=docker/dockerfile:1

# Pinned baseline versions for the course environment. Override these from
# devcontainer.json -> build.args if you need to move them.
ARG MISE_VERSION=2026.11.7
ARG BUN_VERSION=1.4.4
ARG BIOME_VERSION=2.6.6
ARG NODE_MAJOR=22
ARG OPENCODE_VERSION=2.2.7

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG MISE_VERSION
ARG BUN_VERSION
ARG BIOME_VERSION
ARG NODE_MAJOR
ARG OPENCODE_VERSION

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# This image intentionally contains only the course toolchain plus OpenCode
# itself. It does not bake in any other coding-agent CLI or mount its credential
# volumes: the agent built in the course can run arbitrary bash, so unrelated
# tokens should not live in the same container.
#
# Course prerequisites:
#   mise        - installs and pins the project toolchain
#   bun         - runtime, package manager, test runner (installed via mise)
#   node/npm    - npx is required by the image/video generation skill
#   opencode    - the coding agent CLI, available in the Cursor terminal
#   ripgrep     - the search_files tool shells out to rg
#   figlet      - the big_text skill
#   jq          - inspecting the JSONL session logs
#   git/curl/build-essential - general development and package installs
RUN export DEBIAN_FRONTEND=noninteractive \
    && for attempt in 1 2 3; do \
        apt-get update && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 10; \
    done \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        figlet \
        git \
        gnupg \
        jq \
        ripgrep \
        unzip \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode (pinned) so `opencode` is available in the Cursor terminal.
# OpenCode 2 is published as @opencode/cli (the opencode-ai package only carries
# OpenCode 1); its postinstall script copies the binary for this build platform.
# A global install as root lands in npm's global bin directory (here /usr/bin),
# which is on the default PATH for login and non-login shells alike, so no shell
# rc changes are needed.
RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
    && opencode --version \
    && opencode --version | grep -F "${OPENCODE_VERSION}"

USER vscode

# Put the course's user-level install locations ahead of the system paths:
#   .local/bin              - where the course's `curl https://mise.run | sh` installs
#   .local/share/mise/shims - mise-managed tools (bun, bunx, ...)
#   .bun/bin                - fallback for a direct bun installation
ENV PATH="/home/vscode/.local/bin:/home/vscode/.local/share/mise/shims:/home/vscode/.bun/bin:${PATH}"
ENV MISE_YES=1

# Install mise in the same location the course uses, so the Chapter 01
# `curl https://mise.run | sh` gate is already satisfied (and re-running it is
# a no-op or an upgrade rather than a second installation).
RUN curl -fsSL https://mise.run \
      | MISE_VERSION="v${MISE_VERSION#v}" \
        MISE_INSTALL_PATH=/home/vscode/.local/bin/mise \
        MISE_INSTALL_HELP=0 \
        sh \
    && mise --version

# Pre-install the course baseline bun and biome through mise. A project-level
# mise.toml created in Chapter 01 overrides these global pins automatically.
# biome is global because the course's `mise run check` task calls `biome`
# directly, rather than through `bun run` or `node_modules/.bin`.
RUN mise use -g "bun@${BUN_VERSION}" "biome@${BIOME_VERSION}" \
    && mise install \
    && mise reshim \
    && bun --version \
    && biome --version

# Activate mise for interactive shells so `mise run`, tool shims, and future
# [env] entries in mise.toml behave as they do on a normal workstation.
RUN printf '\n# mise (weekend-coding-agent)\nif command -v mise >/dev/null 2>&1; then\n  eval "$(mise activate bash)"\nfi\n' >> /home/vscode/.bashrc

# Fail the build early if a course-critical tool is missing.
RUN node --version \
    && npm --version \
    && opencode --version \
    && rg --version \
    && jq --version \
    && git --version \
    && biome --version \
    && echo OK | figlet >/dev/null
