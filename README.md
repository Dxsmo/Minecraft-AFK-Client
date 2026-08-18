# Minecraft AFK Client Management Service

A self-hosted, production-oriented web service to manage multiple Minecraft
AFK bot accounts: start/stop/restart them independently, watch a live
per-account console, run commands, configure AFK/movement behavior, and
control access with a proper user/role system. Built to run comfortably on
a Raspberry Pi 5 (8 GB) and be exposed to the internet behind Cloudflare.

---

## 1. Tech stack & architecture

```
Frontend (React + TS + Vite + Tailwind)
        │  HTTP + WebSocket (cookies, CSRF header)
        ▼
API / WebSocket layer (Fastify)
        │
        ▼
Application services (auth, users, accounts, commands, logging)
        │
        ▼
Minecraft Client Manager (ClientManager)
        │
        ▼
MinecraftClient instances ──spawn──▶ azalea-bot (Rust subprocess, NDJSON over stdio)
        │                                    │  AFK / Movement / Auto-command
        ▼                                    ▼
Minecraft Server(s) ◀────────────────────────┘
```

| Layer     | Choice                                                        |
|-----------|----------------------------------------------------------------|
| Backend   | Node.js 20+, TypeScript, Fastify, `@fastify/websocket`         |
| Minecraft | [Azalea](https://github.com/azalea-rs/azalea) (Rust) bot, run as a per-account subprocess |
| Database  | SQLite via Prisma ORM                                          |
| Auth      | Argon2id password hashing, **server-side sessions** (cookie + DB), CSRF double-submit cookie |
| Logging   | Pino (structured JSON), secrets redacted                       |
| Frontend  | React + TypeScript + Vite + Tailwind CSS + React Router         |
| Reverse proxy | Caddy (automatic HTTPS, low resource use)                  |
| Deployment | Docker Compose (primary) or systemd (fallback)                |

**Why sessions instead of JWT?** Sessions are stored server-side (SQLite),
so disabling a user or forcing logout takes effect immediately — no token
blocklist needed. This is simpler to reason about and audit on a
single-node Raspberry Pi deployment.

Backend module layout (`backend/src`):

```
api/            system status, audit log endpoints
auth/           password hashing, sessions, RBAC middleware, login routes
users/          user CRUD (admin-only)
accounts/       Minecraft account CRUD, ownership checks, assignments
minecraft/      MinecraftClient (state machine + subprocess control), ClientManager
rust-bot/       Azalea-based Minecraft bot compiled to a native binary (Rust)
commands/       permission-checked command dispatch
websocket/      live console + dashboard WebSocket routes
logging/        pino logger, console log persistence, audit log
database/       Prisma client singleton
config/         typed environment configuration
```

---

## 2. Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose (recommended deployment path — it compiles the
  Rust bot for you, so you don't need a local Rust toolchain)
- A Minecraft server to connect the bots to (any recent version; set
  `minecraftVersion` per account or leave it on auto-detect)
- **Only if building the bot outside Docker:** a Rust **nightly** toolchain
  (`rustup toolchain install nightly`) — Azalea uses nightly-only features.
  See section 6 for the one-line build command.

---

## 3. Local development

### 3.1 Backend

```bash
cd backend
cp ../.env.example .env        # then edit values, see section 4
npm install
npx prisma migrate dev         # creates backend/data/afk.db + applies schema
# Build the Azalea bot once (needs a Rust nightly toolchain). MinecraftClient
# looks for the binary at rust-bot/target/{release,debug}/azalea-bot.
( cd rust-bot && cargo +nightly build --release )
npm run dev                    # http://localhost:4000
```

> Skipping the `cargo build` step is fine if you only work on the web app —
> the backend starts normally and simply reports "azalea-bot binary not found"
> when you try to start a client.

On first start, if no ADMIN user exists yet, one is created automatically
from `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` in `.env` (defaults
to `Desmo` / whatever you set — **change the default password**). After
that, credentials only live in the database as an Argon2 hash.

### 3.2 Frontend

```bash
cd frontend
npm install
npm run dev                    # http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `http://localhost:4000`
(see `frontend/vite.config.ts`), so both servers must be running.

### 3.3 Tests

```bash
cd backend
npm test
```

Runs against an isolated `backend/data/test.db` (never your dev/prod
database). Covers: password hashing, session lifecycle, RBAC/ownership
checks for Minecraft accounts, command-execution permission checks, user
service invariants (last-admin protection, session invalidation), and the
`MinecraftClient` state machine (`OFFLINE → CONNECTING → ONLINE`,
reconnect scheduling, manual disconnect, command dispatch, NDJSON event
handling) using a **mocked `azalea-bot` subprocess** — no real Minecraft
server or compiled Rust binary is required to run the tests.

---

## 4. Environment variables

Copy `.env.example` to `.env` (repo root) for Docker Compose, or to
`backend/.env` for local `npm run dev`. **Never commit `.env`.**

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `production` / `test` |
| `HOST`, `PORT` | Backend bind address (default `0.0.0.0:4000`) |
| `PUBLIC_ORIGIN` | Origin the frontend is served from |
| `DATABASE_URL` | SQLite file path, e.g. `file:./data/afk.db` |
| `SESSION_SECRET` | Long random string (`openssl rand -hex 32`) |
| `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE` | Session cookie tuning; keep `SESSION_COOKIE_SECURE=true` in production (HTTPS) |
| `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD` | Only used to bootstrap the very first admin |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW` | Brute-force protection on `/api/auth/login` |
| `LOG_LEVEL` | Pino log level |
| `CORS_ORIGINS` | Allowed origins (only relevant when frontend/API are on different origins, e.g. local dev) |
| `SITE_ADDRESS` | Domain for the Caddy container (see `docker-compose.yml` / section 6) |

---

## 5. Admin & user management

- The **first** admin is bootstrapped from `.env` on first boot (see above).
- Admins manage further users under **Users** in the sidebar: create,
  change role, disable/enable, delete, and reset passwords.
- The system will always refuse to delete/disable/demote the **last**
  remaining active admin, so you can't lock yourself out.
- Any user can change their own password under **Settings** (requires the
  current password; invalidates all existing sessions on success).
- Roles: `ADMIN` (sees/manages everything) and `USER` (only sees Minecraft
  accounts explicitly assigned to them, enforced **server-side** on every
  API route — not just hidden in the UI).

---

## 6. Minecraft account configuration

Any authenticated user can create a Minecraft account under **Dashboard →
New account** (they're automatically the sole assignee; admins can grant
additional users access afterwards in the account's **Settings** panel):

- `name` – the account's display name. For **offline** accounts this is the
  Minecraft username you type in and is also the name the bot joins with.
  For **Microsoft** accounts you don't set it — the account is auto-named
  after the real in-game username once the bot signs in.
- `serverHost` / `serverPort`
- `minecraftVersion` – selectable from a dropdown of supported releases, or
  left on auto-detect; changing it applies immediately
- `authType` – `OFFLINE` (cracked/offline server) or `MICROSOFT`. For
  `MICROSOFT` you provide **only the account email**, which is set once at
  creation and can't be changed afterwards (to use a different account,
  delete and recreate). Azalea authenticates via Microsoft's **device-code
  flow**: the first time the bot starts, the account page shows a live
  sign-in link + code; open it, approve once, and the token is cached on
  disk (`data/bot-cache/<account>/`) so subsequent starts are silent. No
  password is ever entered or stored.
- AFK / Movement behavior toggles + AFK interval
- Auto-command: an optional chat message/command sent automatically at a
  configurable interval (minutes), independent of the AFK/movement
  behaviors — configured per account in **Settings**
- `autoReconnect` – fixed 30s retry delay (±2s jitter) after a dropped
  connection, retried indefinitely as long as the client isn't manually
  stopped; can be disabled per account at any time
- Any admin or user assigned to the account can edit its settings,
  start/stop/restart it, and delete it entirely; only admins can grant
  *other* users access via the assignments list

The Microsoft account email (`credentialsSecret`) is **never** included in
any API response sent to the frontend — only account metadata and live
status are exposed.

### Server resource/texture packs

If the target server requires accepting a resource pack before letting a
player fully join, the Azalea bot accepts it automatically (Azalea's
built-in `AcceptResourcePacksPlugin`). There's no renderer to actually
download/display the pack, so there's nothing to prompt a human for — this
works out of the box for texture-pack-gated servers.

### Reliable "online" detection

The Rust bot reports lifecycle events over NDJSON: `login` when the login
packet arrives and `spawn` once the player is fully in a loaded world. The
Node side marks the client `ONLINE` on `spawn`. If a connection attempt
neither spawns nor fails within 5 minutes (a hung subprocess), it's
recycled and retried. When the connection later ends, the Rust process
exits and Node schedules the next attempt on its fixed 30s timer — Node,
not Azalea, owns the reconnect policy.

### Azalea version pin (tracking new Minecraft releases)

The Rust bot pins Azalea to a specific GitHub commit in
`backend/rust-bot/Cargo.toml` (Azalea publishes Minecraft protocol support
on `main` well ahead of crates.io releases):

```
azalea = { git = "https://github.com/azalea-rs/azalea", rev = "<commit-sha>" }
```

**To update** (e.g. for a newly released Minecraft version): pick a commit
from [azalea-rs/azalea](https://github.com/azalea-rs/azalea) that supports
it, update the `rev` in `Cargo.toml`, then rebuild
(`cd backend/rust-bot && cargo +nightly build --release`, or just rebuild
the Docker image). Pinning an exact commit keeps builds reproducible.

Azalea completes the join sequence (including the configuration phase and
resource-pack exchange) on servers where some other headless clients get
stuck — which is exactly why this project uses it.

### NDJSON subprocess protocol

`MinecraftClient` (Node) and `azalea-bot` (Rust) talk over the subprocess's
stdio, one JSON object per line (see `backend/rust-bot/src/protocol.rs` and
`backend/src/minecraft/MinecraftClient.ts`):

- **stdin, first line:** a `Config` object (host, port, auth type, username,
  email, cache dir, behavior settings).
- **stdin, subsequent lines:** `Command`s — `{"type":"chat","text":…}`,
  `{"type":"configure",…}` (live behavior update), `{"type":"disconnect"}`.
- **stdout:** one `OutEvent` per line — `login`, `spawn`, `chat`,
  `msa_code`, `profile`, `disconnect`, `connection_failed`, `warning`,
  `behavior_log`, `fatal_error`. Azalea's own logging is sent to stderr
  (`RUST_LOG=error`) so it never corrupts the protocol.

### AFK / Movement behavior system

Behaviors live in the Rust bot (`backend/rust-bot/src/behaviors.rs`) and are
driven from Azalea's game tick:

- **AFK** – periodic random look-around + jump to avoid inactivity kicks
- **Movement** – occasional short random walk
- **Auto-command** – periodic chat message/command

They read a shared config that `{"type":"configure"}` updates live, so
toggling AFK/movement/auto-command or changing intervals in the UI takes
effect without reconnecting.

---

## 7. Live console & commands

Each account has a live, terminal-styled console (`/accounts/:id`) backed
by a WebSocket (`/ws/accounts/:id`), showing:

- `SYSTEM` events (connect/reconnect/disconnect)
- `CHAT` (other players' chat)
- `SERVER_MESSAGE` (non-chat server messages)
- `USER_COMMAND` (what you sent)
- `WARNING` / `ERROR`

Commands typed in the console (or sent via `POST
/api/minecraft/accounts/:id/command`) are forwarded as-is to the
Minecraft server through the bot. **The service never bypasses server
permissions** — if the bot account isn't OP'd or lacks a permission-plugin
grant, the vanilla server will reject the command exactly as it would for
a real player. The last 2000 console lines per account are persisted to
SQLite and pruned automatically.

---

## 8. Security summary

- Argon2id password hashing (tuned for constrained hardware)
- Server-side sessions, `HttpOnly` + `SameSite=Lax` cookies,
  `Secure` in production. Cookies are browser-*session* cookies (no
  `Expires`/`Max-Age`), so closing the browser logs the user out, and
  every backend restart wipes all sessions server-side too — a fresh
  login is always required after either.
- Persistent data (users, Minecraft accounts, assignments, console/audit
  logs) survives restarts via the SQLite file in the `backend_data`
  Docker volume; only *sessions* are intentionally cleared on restart.
- CSRF protection via double-submit cookie (`afk_csrf` cookie +
  `x-csrf-token` header, enforced on every mutating request)
- Full RBAC + per-account ownership checks enforced in every API route
  (not just hidden in the UI)
- Rate limiting: global (200 req/min) + strict login limiter
  (`LOGIN_RATE_LIMIT_MAX` per `LOGIN_RATE_LIMIT_WINDOW`)
- Security headers via `@fastify/helmet`
- Zod input validation on every request body
- Audit log for admin-critical actions (user/account CRUD, assignments,
  start/stop/restart, commands executed, logins)
- Passwords/secrets are redacted from all log output (Pino `redact`)
  and never returned by any API endpoint
- Minecraft credentials (`credentialsSecret`) never leave the backend

---

## 9. Docker deployment (recommended)

```bash
cp .env.example .env      # edit SESSION_SECRET, INITIAL_ADMIN_PASSWORD, SITE_ADDRESS, ...
docker compose build
docker compose up -d
docker compose logs -f
```

This starts two containers:

- **backend** – the Fastify API + WebSocket server + all Minecraft clients
  (SQLite DB persisted in the `backend_data` volume). The image is built in
  multiple stages: a Rust nightly stage compiles the `azalea-bot` binary, a
  Node stage compiles the TypeScript, and the slim runtime stage bundles
  both. The first `docker compose build` therefore takes a few minutes while
  the Rust dependencies compile; subsequent builds are cached.
- **web** – Caddy, serving the built React SPA and reverse-proxying
  `/api/*` and `/ws/*` to `backend`, listening on `80`/`443`

Set `SITE_ADDRESS` in `.env` to your real domain (e.g. `afk.example.com`)
for Caddy to automatically provision HTTPS via Let's Encrypt, or leave it
as `:80` if Cloudflare (or another proxy) terminates TLS instead. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full Raspberry Pi +
Cloudflare walkthrough (DNS, HTTPS modes, firewall, backups, updates,
troubleshooting).

---

## 10. Documentation index

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Raspberry Pi 5 setup, Docker
  vs systemd, Caddy reverse proxy, Cloudflare DNS/HTTPS, firewall,
  backups, updates, troubleshooting.
- `.env.example` — all environment variables with descriptions.
- `scripts/backup-db.sh` / `scripts/restore-db.sh` — SQLite backup/restore
  (works for both Docker and bare-metal installs).
- `scripts/systemd/afk-backend.service` — systemd unit for the non-Docker
  fallback deployment.

---

## 11. Known limitations / future work

- Microsoft authentication uses Azalea's Microsoft **device-code** flow.
  The account's Microsoft email is stored in `credentialsSecret` and used as
  the token cache key. For unattended Raspberry Pi operation, complete the
  interactive device-code login once (the link + code appear live on the
  account page on first connect) — the resulting token is cached under
  `data/bot-cache/<account>/` so subsequent restarts don't require
  re-authentication.
- No built-in email/2FA — access control relies on strong passwords +
  the RBAC/audit system described above. Consider adding 2FA if exposing
  this beyond a small trusted group.
- System monitoring is intentionally minimal (`os.loadavg`/`os.freemem`)
  to keep overhead low on the Pi; no external metrics/agent is bundled.
