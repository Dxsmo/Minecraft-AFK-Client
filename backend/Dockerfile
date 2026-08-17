# syntax=docker/dockerfile:1

# ---- Rust stage: compile azalea-bot binary ----
FROM rustlang/rust:nightly AS rust-builder
WORKDIR /rust-bot
COPY rust-bot/Cargo.toml rust-bot/Cargo.lock ./
COPY rust-bot/src ./src
RUN cargo build --release

# ---- Build stage: compile TypeScript + generate Prisma client ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Native deps (argon2) need a toolchain to build from source on arm64/amd64.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: slim image with only production deps + azalea-bot binary ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Copy compiled azalea-bot binary from Rust build stage
COPY --from=rust-builder /rust-bot/target/release/azalea-bot /app/azalea-bot
RUN chmod +x /app/azalea-bot

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
