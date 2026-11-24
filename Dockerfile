# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:26-alpine AS production

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=3000 \
    DATABASE_PATH=/data/uhabits.db

WORKDIR /app

RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER app

VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}${BASE_PATH:-}/health" || exit 1

CMD ["node", "dist/index.js"]
