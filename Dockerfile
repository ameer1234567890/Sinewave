# Sinewave: the CMS dashboard, API, web player and SQLite database, in one container.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PLAYER_DIR=/app/player

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./
COPY player/ /app/player/

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
