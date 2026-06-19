FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq ripgrep openssh-client ca-certificates tzdata procps expect \
 && rm -rf /var/lib/apt/lists/* \
 && update-ca-certificates
# `expect` provee `unbuffer`, que aloca un PTY para agy (su modo headless
# descarta stdout sin TTY).

# CLIs de agente vía npm. gemini-cli lo retira Google el 2026-06-18; claude-code
# es el backend de código estable. (Antigravity CLI `agy` se instala más abajo.)
RUN npm install -g @google/gemini-cli@latest @anthropic-ai/claude-code@latest

# El user "node" viene preinstalado en node:22-slim con UID 1000 (coincide con host)
RUN mkdir -p /home/node/.gemini /home/node/.claude /workspace \
 && chown -R node:node /home/node /workspace

# Config mínima de Claude horneada (onboarding + bypass) para correr headless sin
# prompts. Vive en la raíz del HOME (no se puede montar sin tapar todo el home),
# y como archivo del container permite que claude la reescriba (rename) sin EBUSY.
RUN printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' \
      > /home/node/.claude.json \
 && chown node:node /home/node/.claude.json

USER node
WORKDIR /workspace
ENV HOME=/home/node
ENV PATH="/home/node/.local/bin:${PATH}"

# Antigravity CLI (`agy`) — reemplazo de gemini-cli. Instalador OFICIAL de Google
# (descarga un binario estático ~15MB a ~/.local/bin/agy). Requiere red en build.
# Si preferís no correr el instalador, comentá esta línea: claude y gemini igual
# funcionan; solo el agente `agy` quedará no disponible.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

CMD ["claude", "--version"]
