FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq ripgrep openssh-client ca-certificates tzdata procps \
 && rm -rf /var/lib/apt/lists/* \
 && update-ca-certificates

RUN npm install -g @google/gemini-cli@latest

# El user "node" viene preinstalado en node:22-slim con UID 1000 (coincide con host)
RUN mkdir -p /home/node/.gemini /workspace \
 && chown -R node:node /home/node /workspace

USER node
WORKDIR /workspace
ENV HOME=/home/node

CMD ["gemini", "--version"]
