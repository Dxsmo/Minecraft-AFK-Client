# syntax=docker/dockerfile:1

# ---- Rust stage: compile azalea-bot binary ----
FROM rustlang/rust:nightly AS rust-builder
WORKDIR /rust-bot
COPY ./backend/rust-bot/Cargo.toml ./backend/rust-bot/Cargo.lock ./
COPY ./backend/rust-bot/src ./src
RUN cargo build --release

# ---- Build stage: compile TypeScript + generate Prisma client ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Native deps (argon2) need a toolchain to build from source on arm64/amd64.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

COPY ./backend/package.json ./backend/package-lock.json* ./
RUN npm ci

COPY ./backend/prisma ./prisma
RUN npx prisma generate

COPY ./backend/tsconfig.json ./
COPY ./backend/src ./src
RUN npm run build

# ---- Runtime stage: slim image with only production deps + azalea-bot binary ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

COPY ./backend/package.json ./backend/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY ./backend/prisma ./prisma

# Copy compiled azalea-bot binary from Rust build stage
COPY --from=rust-builder /rust-bot/target/release/azalea-bot /app/azalea-bot
RUN chmod +x /app/azalea-bot

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
