# Debian's own Chromium, not a Playwright browser download — the official
# Playwright image is ~1.5GB and we only need one browser.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV OAC_BROWSER_PATH=/usr/bin/chromium \
    OAC_CONFIG=/config/config.json \
    OAC_DEFAULT_DEST=/vault/raw \
    OAC_HOST=0.0.0.0 \
    NODE_ENV=production

WORKDIR /app

# Dependencies first so code edits don't re-run npm install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js ./
COPY public ./public

# node:22-slim ships an unprivileged `node` user; the app never needs root.
RUN mkdir -p /config /vault && chown -R node:node /app /config
USER node

EXPOSE 4571
CMD ["node", "server.js"]
