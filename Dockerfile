# Sinewave: the CMS dashboard, API, web player and SQLite database, in one container.
FROM node:22-alpine

# Headless Chromium takes the screenshots shown on web page cards in the dashboard (server/src/webpreview.js).
# Noto covers most scripts and emoji so pages don't render as boxes.
RUN apk add --no-cache chromium font-noto font-noto-emoji

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=8080 \
    DATA_DIR=/data \
    PLAYER_DIR=/app/player \
    PUID=1000 \
    PGID=1000

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./
COPY player/ /app/player/

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

# Starts as root only long enough to give /data to PUID:PGID, then drops to that user.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/start.js"]
