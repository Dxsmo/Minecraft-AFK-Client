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
MinecraftClient instances (Mineflayer) ── BehaviorManager (AFK / Movement)
        │
        ▼
Minecraft Server(s)
```

| Layer     | Choice                                                        |
|-----------|----------------------------------------------------------------|
| Backend   | Node.js 20+, TypeScript, Fastify, `@fastify/websocket`         |
| Minecraft | Mineflayer (pinned to a specific GitHub commit, see below)     |
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
minecraft/      MinecraftClient (state machine), ClientManager, behaviors/
commands/       permission-checked command dispatch
websocket/      live console + dashboard WebSocket routes
logging/        pino logger, console log persistence, audit log
database/       Prisma client singleton
config/         typed environment configuration
```

---

## 2. Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose (recommended deployment path)
- A Minecraft server to connect the bots to (any recent version; set
  `minecraftVersion` per account to match)

---

## 3. Local development

### 3.1 Backend

```bash
cd backend
cp ../.env.example .env        # then edit values, see section 4
npm install
npx prisma migrate dev         # creates backend/data/afk.db + applies schema
npm run dev                    # http://localhost:4000
```

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
reconnect scheduling, manual disconnect, command dispatch) using a mocked
Mineflayer bot — no real Minecraft server is required to run the tests.

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

- `name` – internal bot identifier (also used as the offline-mode
  username by default)
- `serverHost` / `serverPort`
- `minecraftVersion` – selectable from a dropdown of supported releases;
  changing it applies immediately and restarts the client if it's online
- `authType` – `OFFLINE` (cracked/offline server) or `MICROSOFT`. For
  `MICROSOFT`, the account **email and password are set only once at
  creation and cannot be changed afterwards** — the update API does not
  accept these fields at all, so changing credentials requires deleting
  the account and creating a new one. Password-based sign-in does not
  work for Microsoft accounts with 2FA/modern security features enabled;
  leave the password empty in that case and use the device-code sign-in
  link shown live on the account page instead.
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

Credentials (`credentialsSecret`/`credentialsPassword`, used for
Microsoft auth) are **never** included in any API response sent to the
frontend — only account metadata and live status are exposed.

### Server resource/texture packs

If the target server requires accepting a resource pack before letting a
player fully join, `MinecraftClient` automatically accepts it on the
bot's behalf (there's no renderer to actually download/display it, so
there's nothing to prompt a human for).

### Reliable "online" detection

Some servers (especially ones behind anti-bot/verification systems, or
that simply never resend default full health) delay or never send the
packet Mineflayer's built-in `spawn` event depends on, even though the
account has already fully joined and is visible to other players (e.g.
in the tab list). To avoid getting stuck showing `CONNECTING...`
indefinitely in that case, `MinecraftClient` also treats the mandatory
initial position-sync packet (`forcedMove`) as sufficient evidence of a
successful join — whichever of `spawn`/`forcedMove` arrives first marks
the client `ONLINE`. A connection attempt is abandoned and retried if
either (a) **no packets at all** have been received from the server for
90 seconds, or (b) the attempt has been running for more than 3 minutes
in total regardless of packet activity — the latter specifically catches
servers whose anti-bot/verification systems hold a connection in limbo
indefinitely (still exchanging keep-alives) without ever releasing it
into actual play.

### Mineflayer version pin (tracking new Minecraft releases)

Mineflayer's last npm release (`4.37.1`) does not yet support every very
recent Minecraft version (e.g. the `26.x` release line) — protocol
support for new versions typically lands on the project's `master`
branch on GitHub before it's cut into an npm release. To get support for
the newest versions without waiting on an npm release, `backend/package.json`
pins Mineflayer directly to a specific GitHub commit instead of an npm
version range:

```
"mineflayer": "github:PrismarineJS/mineflayer#<commit-sha>"
```

**To update this pin** (e.g. once a new Minecraft version is released and
support is merged upstream): check
[PrismarineJS/mineflayer](https://github.com/PrismarineJS/mineflayer) for
the latest relevant commit on `master`, update the SHA in
`backend/package.json`, then run `npm install` in `backend/` and rebuild.
Pinning an exact commit (rather than tracking `master` directly) keeps
builds reproducible — `master` can change under you at any time otherwise.

**Important caveat:** getting Mineflayer to recognize a server's protocol
version is necessary but not always sufficient to successfully join.
Some servers run anti-bot/verification systems (common on public survival
servers) that hold *any* automated/headless client in a "limbo" state
indefinitely — visible in the player list, but never actually completing
the join sequence — regardless of which bot library or protocol version
is used. If a specific account/server combination consistently times out
after "Server requested a resource pack" with no further progress even
after a version update, this is the most likely explanation, and it's not
something fixable from the client side. Check whether the server
documents any bot-verification requirements before assuming it's a bug.

### AFK / Movement behavior system

`BehaviorManager` (in `backend/src/minecraft/behaviors/`) attaches small,
independent `Behavior` implementations to a connected bot:

- `AfkBehavior` – periodic look-around + jump to avoid inactivity kicks
- `MovementBehavior` – occasional short random walk

Behaviors are started/stopped together with the bot's connection and are
fully decoupled from `MinecraftClient`, so adding a new behavior later
only means adding one more class + registering it in `BehaviorManager`.

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
  (SQLite DB persisted in the `backend_data` volume)
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

- Microsoft authentication support in `MinecraftClient` uses Mineflayer's
  built-in `auth: "microsoft"` device-code flow; the account's Microsoft
  email is stored in `credentialsSecret`. For unattended Raspberry Pi
  operation, complete the interactive device-code login once (watch the
  backend logs on first connect) — Mineflayer caches the resulting token
  under its own cache directory so subsequent restarts don't require
  re-authentication.
- No built-in email/2FA — access control relies on strong passwords +
  the RBAC/audit system described above. Consider adding 2FA if exposing
  this beyond a small trusted group.
- System monitoring is intentionally minimal (`os.loadavg`/`os.freemem`)
  to keep overhead low on the Pi; no external metrics/agent is bundled.
