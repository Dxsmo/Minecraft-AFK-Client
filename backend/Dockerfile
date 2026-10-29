# syntax=docker/dockerfile:1
# Build context is the ./backend directory (see docker-compose.yml).

# ---- Build stage: compile TypeScript + generate the Prisma client ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Native argon2 builds must work on arm64 and amd64.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,id=afk-backend-npm,target=/root/.npm,sharing=locked npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# The builder and runtime use the same Node/Debian base and architecture, so
# native production modules can be compiled once here and copied forward.
RUN npm prune --omit=dev

# ---- Runtime stage: website and SoulFire control adapters ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Authenticated RPC, Prisma and HTTPS assets need certificates and OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

COPY assets ./assets

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "env -u RUST_LOG npx prisma migrate deploy && node dist/server.js"]
