FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq ripgrep openssh-client ca-certificates tzdata procps \
 && rm -rf /var/lib/apt/lists/* \
 && update-ca-certificates

# CLIs de agente soportados. gemini-cli se retira el 2026-06-18 (lo deja Google);
# claude-code es el backend estable. Antigravity CLI se sumará cuando sus flags
# headless estén confirmadas.
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

CMD ["claude", "--version"]
