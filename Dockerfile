# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS worker-base
ARG CODEX_VERSION=0.162.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
FROM worker-base AS worker
COPY server ./server
COPY worker ./worker
RUN mkdir -p /state && chown node:node /state
USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/worker/index.js"]
