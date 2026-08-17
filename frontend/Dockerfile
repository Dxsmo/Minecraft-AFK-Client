# syntax=docker/dockerfile:1

# ---- Build stage: produce the static Vite production build ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage: Caddy serves the static build and reverse-proxies the API ----
FROM caddy:2-alpine AS runtime
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
