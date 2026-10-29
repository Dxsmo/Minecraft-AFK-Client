# Minecraft AFK Client Management Service

A self-hosted, production-oriented web service to manage multiple Minecraft
Minecraft bot accounts: start/stop/restart them independently, watch a live
per-account console, run commands, configure account automation, and
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
MinecraftClient instances → SoulFire controllers (shared Node scheduler)
        │                    │ authenticated SDK / private RPC
        │                    ▼
        │              SoulFire 2.10.6 + native held-input extension (Java 25)
        ▼                    │ Java / ViaBedrock
Minecraft Server(s) ◀─────────┘
```

| Layer     | Choice                                                        |
|-----------|----------------------------------------------------------------|
| Backend   | Node.js 24+, TypeScript, Fastify, `@fastify/websocket`         |
| Minecraft | [SoulFire 2.10.6](https://github.com/soulfiremc-com/SoulFire) shared Java/Bedrock engine |
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
notes/          rich-text notes, owner-managed read/write sharing
minecraft/      MinecraftClient (state machine + subprocess control), ClientManager
soulfire/       common SDK adapter, authentication migration and automation
commands/       permission-checked command dispatch
websocket/      live console + dashboard WebSocket routes
logging/        pino logger, console log persistence, audit log
database/       Prisma client singleton
config/         typed environment configuration
```

---

## 2. Prerequisites

- Node.js 24+ and npm
- Docker + Docker Compose (recommended; builds the SoulFire input extension)
- A server compatible with SoulFire's installed Java/ViaBedrock codecs
- For local engine development outside Docker: Java 25 JDK + Python 3

Existing installation: see [SoulFire migration and account retention](docs/SOULFIRE-MIGRATION.md).

---

## 3. Local development

### 3.1 Backend

```bash
cd backend
cp ../.env.example .env        # then edit values, see section 4
npm install
npx prisma migrate dev         # creates backend/data/afk.db + applies schema
# Start SoulFire separately with the input extension and set SOULFIRE_URL /
# SOULFIRE_SECRET_KEY_FILE (see docs/SOULFIRE-MIGRATION.md).
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
reconnect scheduling, manual disconnect, command dispatch, NDJSON event
handling) using mocked SoulFire controllers — no live Minecraft server or Microsoft login
is required for the unit tests.

With Vite running, the uploader-category browser regression check can be run
from the repository root using an installed Playwright and Chrome:

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright UI_URL=http://127.0.0.1:5173 node scripts/ui/uploader-categories-check.mjs
```

It mocks all APIs and sockets and checks admin isolation, uploader grouping,
profiles shared between separate browser contexts, legacy import, failed-write
retries, 500 ms animations and layouts from 320 to 1280 pixels wide.
Set `CHROME_EXECUTABLE` to use a different Chromium executable.

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
- Admins manage further users under **Admin Panel** in the sidebar: create,
  change role, disable/enable, delete, and reset passwords.
- **Restart all** in the Admin Panel restarts the Minecraft accounts that are
  online at the moment of the click, each once with a five-second offline pause.
  Offline/connecting/reconnecting accounts are left alone. The action requires
  an admin session and CSRF token and is recorded in the audit log.
- Admins can assign, change or clear an optional **Minecraft-Name** for each
  website user. The account list shows that creator's small skin head directly
  left of the eye button, including for shared accounts. Heads are fetched from
  [MCHeads](https://mc-heads.net/) through the authenticated backend, with a
  bounded cache and a placeholder if no name is assigned or the service is
  unavailable. Browser requests stay on this website's origin.
- All users can blur/reveal their visible accounts using the eye button.
  Blur status and account order are saved in each website user's database profile
  and restored on every device. Personal sorting never changes another user's
  arrangement, including for shared accounts. Profiles are loaded before cards
  appear, so saved blur settings do not flash unblurred during loading.
- Admin dashboards group accounts by their uploader, with a collapsible category
  for every website user, including users without uploads. Accounts whose uploader
  was deleted appear under **Ohne Uploader**. Category arrows change the category
  order; account arrows move accounts within their uploader's category. Opening
  and closing animates over 500 ms. Category order and open/closed states are saved
  separately in each admin's database profile and restored on every device.
  Normal users keep their flat list of assigned accounts.
- Existing browser blur/category settings are imported once on first use if the
  user has no saved server profile yet. An existing server profile always wins;
  old local keys are only removed after the server confirms the profile. Edits
  save automatically, remain queued on temporary failures with a retry action, and finish
  when navigating between pages. Returning focus refreshes the saved profile.
- The system will always refuse to delete/disable/demote the **last**
  remaining active admin, so you can't lock yourself out.
- Any user can change their own password under **Settings** (requires the
  current password; invalidates all existing sessions on success).
- Roles: `ADMIN` (sees/manages all Minecraft accounts) and `USER` (only sees Minecraft
  accounts explicitly assigned to them, enforced **server-side** on every
  API route — not just hidden in the UI).

Every active user can create notes under **Notizen**. Notes start private,
including against other admins. The creator uses **Zugriff** to grant individual
users **Nur lesen** or **Lesen & schreiben** by entering their exact username;
only existing recipients are listed. Unknown usernames receive feedback rather
than suggestions. Only the creator can change access
or delete the note. Text supports headings, bold, underline, lists and left or
centered alignment in a dark A4-style editor that grows with the document.
Changes save automatically. Concurrent edits preserve the unsaved draft instead
of overwriting a newer version, with options to reload or save a private copy.
There is no word/character cap; each save request has a 64 MiB transport limit.

Website login and sharing match usernames regardless of letter case; passwords
remain case-sensitive. **Anmeldedaten speichern** remembers the username locally
and offers the password to the browser's password manager after a successful
login. Browser confirmation/settings control password saving and autofill;
the website never persists the password in localStorage. Press **Enter** in the
login form to sign in.

---

## 6. Minecraft account configuration

All Java and Bedrock accounts use **SoulFire 2.10.6** through the same scheduler.
The website framework, roles, account IDs and existing data remain in place.
The input extension, authentication migration and complete deployment procedure
are documented in [SoulFire migration](docs/SOULFIRE-MIGRATION.md).

- New accounts authenticate once using Microsoft's device-code flow. Passwords
  are never collected. Accepted legacy refresh tokens are imported without
  another sign-in; revoked or incompatible tokens need a new device code.
- The version selector reads SoulFire's installed Java/ViaBedrock codecs. Java
  automatic detection queries the server status. This release exposes Bedrock
  **1.26.51**; other Bedrock versions require a compatible engine release.
- Java and Bedrock accounts are added and authenticated separately. Adding one
  edition never discovers, links or creates an account for the other edition.
- The **Live Cam** tab between Console and Einstellungen shows the selected
  account's real SoulFire POV. It loads only while the tab is open, the account
  is online and the browser document is visible. Multiple viewers share one
  stream per account; leaving the view cancels it when the last viewer leaves.
- Crouch remains held. Silent checks after home/TPA/position transitions run
  after 3 seconds; periodic and restart checks remain. Checks never toggle off.
- Auto button Off/Left/Right holds native Minecraft input without an open video
  session and restores it after respawns/reconnects. Game/server cooldowns apply.
- AutoSell shifts player inventory items into its current sale menu and waits
  for acknowledgments. Timeouts recover with finite deadlines. World changes
  discard stale tasks. Announced restarts pause selling from 10 seconds before
  until **2 minutes after** the restart, including controller reconnects.
- Manual commands take priority. `/desmo` reads nine `/sellmulti` categories.
  CleanSpawner finds a reachable spawner and applies the configured keep/drop/
  sell actions. The client requests **6 chunks** view distance; simulation
  distance remains controlled by the server.
- Clicking an account icon opens the searchable, alphabetically sorted chooser
  containing **1,489 transparent PNGs**, with custom upload still available.
- Reconnect remains fixed at 15 seconds, with a five-second manual restart wait.
  Real game-state checks feed the existing frozen-client watchdog.

### Feature visibility

Live inventory viewing, moving and dropping remain removed for all roles,
including their API routes. Balance polling, automatic home queries, home
shortcuts, auto-home and auto-TPA remain removed. Manually entered commands
remain available through the console. Microsoft credentials never appear in
account API responses.

---

## 7. Live console & commands

Each account has a live, terminal-styled console (`/accounts/:id`) backed
by a WebSocket (`/ws/accounts/:id`), showing:

- `SYSTEM` events (connect/reconnect/disconnect)
- `CHAT` (other players' chat)
- `SERVER_MESSAGE` (non-chat server messages)
- `USER_COMMAND` (what you sent)
- `WARNING` / `ERROR`

Only slash commands beginning with `/` can be sent from the console, through
its WebSocket or via `POST /api/minecraft/accounts/:id/command`. Plain chat,
empty commands and embedded control characters are rejected before reaching
the bot. Valid commands are forwarded as-is to the
Minecraft server through the bot. **The service never bypasses server
permissions** — if the bot account isn't OP'd or lacks a permission-plugin
grant, the vanilla server will reject the command exactly as it would for
a real player. The last 20,000 console lines per account are persisted to
SQLite and pruned automatically. The console loads recent history and keeps
new lines visible without losing the user's position when reading older output.

Health, hunger and reconnect-attempt counters are no longer collected or sent
as website status telemetry by either bot edition or the supervisor.

Below 1024px the website uses full-width content and a bottom navigation for
Accounts, Admin Panel (admins) and Settings. Account status, lifecycle controls,
console commands and core settings remain available. Sale graphs, account images,
creator avatars, sorting, spawner/access tuning and IP-ban administration are
omitted from this compact view; graphs/images/avatars are not loaded there.
Dense tables become vertical cards, log messages wrap, account dialogs scroll
inside the viewport, and the console reserves space for the bottom navigation.
Restart leaves the account offline for five seconds before reconnecting.

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
  `x-csrf-token` header on authenticated website writes)
- Explicit trusted Origins for website writes/sockets; live connections
  recheck current sessions and account/admin rights before queued actions
- Full RBAC + per-account ownership checks enforced in every API route
  (not just hidden in the UI)
- Rate limiting: global (400 req/min) + strict login limiter
  (twice the legacy `LOGIN_RATE_LIMIT_MAX` per `LOGIN_RATE_LIMIT_WINDOW`, default 10/min)
- Security headers via `@fastify/helmet` and Caddy (including frontend CSP)
- Zod input validation on every request body
- Audit log for admin-critical actions (user/account CRUD, assignments,
  start/stop/restart, commands executed, logins)
- Secret-bearing structured log fields and audit details are redacted;
  public user/account response selectors exclude passwords and tokens
- Minecraft credentials (`credentialsSecret`) never leave the backend

See [the security overview](docs/SECURITY.md) and
[the V4.2.0 review](docs/SECURITY_REVIEW.md) for verification and deployment limits.

---

## 9. Docker deployment (recommended)

```bash
cp .env.example .env      # edit SESSION_SECRET, INITIAL_ADMIN_PASSWORD, SITE_ADDRESS, ...
docker compose build
docker compose up -d
docker compose logs -f
```

This starts three containers:

- **backend**: Fastify, SQLite, WebSockets and all lightweight account controllers
  in one Node runtime. Existing data stays in `backend_data`.
- **soulfire**: the common Java/Bedrock engine and native held-input extension.
  Its accounts, signing key and Minecraft runtime persist in `soulfire_data`.
  RPC is private to the Compose network.
- **web**: Caddy serves the React SPA and proxies `/api/*` and `/ws/*` to the
  backend on public ports 80/443.

For an existing installation, back up both data volumes and use
`bash scripts/update.sh`; see [the migration procedure](docs/SOULFIRE-MIGRATION.md).

Set `SITE_ADDRESS` in `.env` to your real domain (e.g. `afk.example.com`)
for Caddy to automatically provision HTTPS via Let's Encrypt, or leave it
as `:80` if Cloudflare (or another proxy) terminates TLS instead. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full Raspberry Pi +
Cloudflare walkthrough (DNS, HTTPS modes, firewall, backups, updates,
troubleshooting).

---

## 10. Documentation index

- [`docs/RESOURCE-MEASUREMENTS.md`](docs/RESOURCE-MEASUREMENTS.md) — measured local
  backend CPU/RAM, an isolated repeatable benchmark, and a read-only Linux sampler
  for separate Java/Bedrock process measurements on the actual bot host.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Raspberry Pi 5 setup, Docker
  vs systemd, Caddy reverse proxy, Cloudflare DNS/HTTPS, firewall,
  backups, updates, troubleshooting.
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) — V4.2.0 security findings,
  fixes, test evidence and unverified deployment boundaries.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — current protocol, authentication,
  renderer and verification boundaries.
- [`docs/SOULFIRE-MIGRATION.md`](docs/SOULFIRE-MIGRATION.md) — updating, account
  retention, cache import, feature mapping and complete backups.
- `.env.example` — all environment variables with descriptions.
- `scripts/backup-db.sh` / `scripts/restore-db.sh` — SQLite backup/restore
  (works for both Docker and bare-metal installs).
- `scripts/systemd/afk-backend.service` — systemd unit for the non-Docker
  fallback deployment.

---

## 11. Known limitations / future work

- Microsoft can require another sign-in if previous refresh tokens are no longer
  accepted. Automatic companion accounts require successful authentication for
  that edition; ownership/profile restrictions may prevent it.
- The Pi's previous Azalea capacity measurements do not predict SoulFire's
  memory/CPU requirements. Measure real accounts before choosing a capacity.
- SoulFire has screenshot/POV APIs; a website live-view UI is not added by this
  migration. See [current limitations](docs/LIMITATIONS.md).
- No built-in email/2FA — access control relies on strong passwords +
  the RBAC/audit system described above. Consider adding 2FA if exposing
  this beyond a small trusted group.
- System monitoring is intentionally minimal (`os.loadavg`/`os.freemem`)
  to keep overhead low on the Pi; no external metrics/agent is bundled.
