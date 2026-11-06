# syntax=docker/dockerfile:1
# Build context is the ./backend directory (see docker-compose.yml).

# ---- Shared dependencies: unchanged source files reuse these layers ----
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app

# Native argon2 builds must work on arm64 and amd64.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,id=afk-backend-npm,target=/root/.npm,sharing=locked npm ci

COPY prisma ./prisma
RUN npx prisma generate

# Prepare production modules independently of application source changes.
# Keep the generated Prisma client in this stage before removing dev tools.
FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

# ---- Build stage: compile TypeScript ----
FROM dependencies AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: website and SoulFire control adapters ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Authenticated RPC, Prisma and HTTPS assets need certificates and OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY --from=production-dependencies /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

COPY assets ./assets

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "env -u RUST_LOG npx prisma migrate deploy && node dist/server.js"]
