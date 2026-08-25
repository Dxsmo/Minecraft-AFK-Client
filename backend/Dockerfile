# syntax=docker/dockerfile:1
# Build context is the ./backend directory (see docker-compose.yml).

# ---- Rust stage: compile the azalea-bot binary ----
# Must match the runtime image's Debian release (bookworm) so the compiled
# binary links against a compatible glibc — the default trixie-based
# rustlang/rust:nightly produces a binary that needs a newer glibc than
# node:20-bookworm-slim provides.
#
# Pinned to an EXACT nightly date (via rustup) rather than the floating
# "nightly"/"nightly-bookworm" tag. Azalea relies on the unstable
# `generic_const_exprs` feature (see azalea-core's FixedBitSet), which is
# still actively changing upstream in rustc — a newer nightly can (and did)
# start rejecting code that an older nightly accepted. Pinning makes builds
# reproducible; bump RUST_NIGHTLY_DATE deliberately (and re-verify the build)
# rather than silently riding whatever nightly happens to be current.
FROM debian:bookworm-slim AS rust-builder
ARG RUST_NIGHTLY_DATE=2026-08-11
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    --default-toolchain "nightly-${RUST_NIGHTLY_DATE}"
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /rust-bot
COPY rust-bot/Cargo.toml rust-bot/Cargo.lock ./
COPY rust-bot/src ./src
RUN cargo build --release

# ---- Build stage: compile TypeScript + generate the Prisma client ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Native deps (argon2, raknet-native) need a toolchain to build from source on
# arm64/amd64. raknet-native has no arm64 prebuild, so cmake is required to
# compile it on the Raspberry Pi 5 (arm64).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake openssl \
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

# ca-certificates is required for the azalea-bot's HTTPS auth requests
# (login.live.com / Xbox / Minecraft services) — without it reqwest panics
# with "No CA certificates were loaded from the system".
# cmake + toolchain are needed to compile raknet-native (Bedrock RakNet) and
# argon2 during `npm ci`; they are purged again afterwards to keep the image slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apt-get purge -y python3 make g++ cmake && apt-get autoremove -y

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Compiled Azalea bot binary from the Rust build stage.
COPY --from=rust-builder /rust-bot/target/release/azalea-bot /app/azalea-bot
RUN chmod +x /app/azalea-bot

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Clear RUST_LOG for the migration step: Prisma's schema engine is a Rust
# binary that crashes if RUST_LOG is set to certain levels. The Minecraft bot
# subprocess sets its own RUST_LOG when spawned, so the server doesn't need it.
CMD ["sh", "-c", "env -u RUST_LOG npx prisma migrate deploy && node dist/server.js"]
