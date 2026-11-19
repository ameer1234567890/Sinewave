# Sinewave server: the CMS dashboard, API and the web player, in one image.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    MEDIA_DIR=/data/media \
    PLAYER_DIR=/app/player

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./
COPY player/ /app/player/

RUN mkdir -p /data/media && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "src/index.js"]
