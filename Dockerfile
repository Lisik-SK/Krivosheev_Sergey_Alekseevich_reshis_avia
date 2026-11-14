# syntax=docker/dockerfile:1
# ---------- сборка ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- запуск ----------
FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data ./data
COPY deploy/amvera-start.sh ./deploy/amvera-start.sh
# storage/ — база пользователей SQLite. Подключите сюда постоянный диск (volume),
# иначе аккаунты пропадут при пересоздании контейнера.
RUN mkdir -p /app/storage && chown -R node:node /app/storage /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/node/server/index.js"]
