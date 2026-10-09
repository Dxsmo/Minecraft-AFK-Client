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
MinecraftClient instances ──spawn──▶ azalea-bot (Rust subprocess, NDJSON over stdio)
        │                                    │  Crouch / Auto-sell
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
notes/          rich-text notes, owner-managed read/write sharing
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
- Admins can assign, change or clear an optional **Minecraft-Name** for each
  website user. The account list shows that creator's small skin head directly
  left of the eye button, including for shared accounts. Heads are fetched from
  [MCHeads](https://mc-heads.net/) through the authenticated backend, with a
  bounded cache and a placeholder if no name is assigned or the service is
  unavailable. Browser requests stay on this website's origin.
- All users can locally blur/reveal their visible accounts using the eye button.
  The preference is saved separately for each website user in that browser.
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
- Continuous crouching and auto-reconnect
- Auto-sell: send the sell command, wait up to five seconds for the menu and
  its inventory data, shift occupied player slots, and close on the following
  tick. Ready menus proceed immediately, even if a tick was delayed. Full
  content packets distinguish genuinely empty menus from unloaded shells and
  keep the inventory revision used by clicks synchronized. Initially empty
  inventories get the same loading window, so a slow response is not discarded.
  Missing/partial menus time out and retry; diagnostics distinguish a missing
  menu from missing inventory data. Teleports/world changes cancel stale cycles.
  Empty or stale local inventory snapshots do not delay the configured interval.
  World-restart countdowns pause automatic selling from 10 seconds before the
  announced restart until 3 minutes afterwards, including bot reconnects.
  HugoSMP announcements are recognized in both system messages and named chat.
  From the announcement at ten seconds or less, enabled crouch is checked once
  per minute for five minutes. Checks inspect server sneak metadata, reassert
  held input, and survive bot reconnects; a missed check runs on rejoin within
  that window.
  Auto-sell recognizes HugoSMP's `Items verkaufen` menu from the current
  inventory state, even when spawn events or delayed callbacks have cleared
  the request association. Populated late sell menus are reused for selling.
  Spawn selectors and manual menus (including `/home` selections) are left open;
  another explicit command, such as `/home <name>`, can interrupt them.
  Explicit commands are processed on packet/login events as well as ticks,
  so they remain usable while a world transfer is waiting for Spawn. Manual
  commands cancel queued automatic sell commands, flush through the actual
  packet handlers immediately, and pause automation for five seconds. A delayed
  sell-menu response to an interrupted sale is closed without clicking its slots;
  manual menus remain open until another explicit command or world transition.
  A missing tick heartbeat triggers recovery even if chat messages are still arriving.
  During connection configuration, manual commands stay queued until game
  packets can be sent again. Open menus are closed once before the command;
  `Command dispatched` records packet dispatch, not a server acknowledgement.
  Each Java world login/respawn clears the previous loaded-chunk/client-loaded
  markers, so the new server receives its own `PlayerLoaded` acknowledgement
  after the destination chunk loads. Position packets alone cannot start selling
  in an unloaded destination. Spawn adds a bounded two-second stabilization
  guard; continuous pickups do not extend it. Inventory-loading rejections delay
  the next attempt by one second without releasing manual command priority.
  The native AFK network reader processes at most 256 packets or four
  milliseconds of incoming work per update, then lets ticks and outgoing
  commands proceed. Dropped item entities and their visual updates are omitted
  locally; server-side pickup and player/container inventory updates remain
  active. Only raw packet callbacks used by selling and world transitions are
  forwarded to the bot handler. Player physics, other entities, authentication,
  keepalives, compression and encryption remain handled by Azalea. The startup
  console line `AFK-Netzwerk aktiv` confirms that this reader is enabled.
  Empty framed/decompressed payloads have no packet ID and are skipped with one
  diagnostic per connection. Valid one-byte bundle delimiters remain intact.
  Other parse warnings include the payload length and protocol state, are limited
  to one per 30 seconds, and do not prevent processing subsequent packets.
- Sell earnings under the console keep the rolling 5m/1h/24h totals. The small
  bottom-left arrow expands a live graph for the last 1h, 6h or 24h, with time
  labels below and amounts on the right. All views use completed, clock-aligned
  five-minute intervals (12/72/288 points for 1h/6h/24h) and refresh at every
  five-minute boundary. Points become denser as the time range grows. Every
  interval has a time tick; printed labels adapt to available space to remain
  readable. Hover/touch or arrow keys show each exact five-minute timestamp
  and amount.
  Only users with access to the account can read its history. Earnings are kept
  for 25 hours so the oldest complete 24h graph bucket survives cleanup; the
  summary totals remain rolling 5m/1h/24h totals. The website uses document
  scrolling, with the sidebar and header remaining visible and no nested page
  or graph scrollbar. The console keeps its own scrollable log history.
- Spawner: pick the spawner type the account is parked at, then choose per
  produced item whether it is **dropped** out of the spawner or **sold** via the
  spawner's own sell button. Dropping always runs first, and both stop once
  fewer than two stacks of that item remain. Can also run automatically at
  configured times of day ("Nach Zeit leeren").
- Clean Spawner only ever acts on the block the bot is **currently looking at**;
  it never searches the surroundings.
- Item worth (admin-only, own page under Name Sniper at `/item-worth`): on
  request, walks the whole Minecraft 1.21.x item registry (~1500 items) asking
  the server `/worth <item>` and records every price. The item is passed in the
  spaced form (`/worth leaf litter`, not `/worth leaf_litter`) because the
  server rejects registry ids. The sweep is **global**,
  not per account: you pick any number of currently online bots and the queries
  are handed out round-robin (Bot 1 → item A, Bot 2 → item B, Bot 3 → item C,
  Bot 1 → item D, …). The configurable delay (1–60s, default 5s) counts between
  two checks *overall*, so more bots means the same overall speed while each
  individual bot talks that much less often — three bots at 5s scan one item
  every 5s but each bot only writes every 15s. Prices are server-wide, so all
  bots feed one shared price list. From the second sweep onward every price
  difference is flagged in the UI, which is what makes unannounced price
  changes ("off metas") visible. The scan runs only when an admin starts it,
  persists its cursor after every single item, skips a bot that goes offline
  (it rejoins automatically), parks itself in `PAUSED` when *no* selected bot
  is online, and resumes on its own — including across a backend restart. The
  item list is generated by `scripts/generate-item-registry.mjs`; the reply
  parsing and the scan state machine are covered by tests in
  `backend/test/minecraft/`.
  The page shows the items being checked live, and has two further tabs:
  *Verdächtig* lists items whose price breaks the consensus of their own
  cosmetic variant family (every boat costs $1, one costs $2.50) — the clearest
  signal of a deliberate, unannounced change. Only families that are normally
  priced identically are compared (wood types, dye colours); genuinely
  different materials such as iron and gold are never grouped, which would
  otherwise flood the list with false positives. *Verlauf* is a permanent
  archive: every scan's complete price list is stored, so a newer scan never
  destroys an older one and any past price stand stays retrievable.
- `autoReconnect` – fixed 15s retry delay (no jitter) after a dropped
  connection, retried indefinitely as long as the client isn't manually
  stopped; can be disabled per account at any time
- Any admin or user assigned to the account can edit its settings,
  start/stop/restart it, and delete it entirely. Admins and creators who still
  have access can grant other users access by entering their exact username in
  **Settings → Access**. This shows existing assignments rather than all users.

The Microsoft account email (`credentialsSecret`) is **never** included in
any API response sent to the frontend — only account metadata and live
status are exposed.

### Bedrock UDP connection diagnostics

If Microsoft authentication succeeds but Bedrock repeatedly reports a
`RakNet/UDP connection ... Connect timed out`, run this from the repository
on the affected host. It uses the existing backend container's network,
without rebuilding the image or stopping accounts:

```sh
git pull --ff-only
docker compose exec -T backend node --input-type=module < backend/scripts/diagnose-bedrock.mjs
```

The default target is `HugoSMP.net:19132`. A custom target can be tested with
`node backend/scripts/diagnose-bedrock.mjs hostname 19132` where Node is installed.
The test reports the resolved IPv4 address, status advertisement, and both
offline RakNet handshake steps (including cookie negotiation and four MTU
sizes). It sends no Microsoft credentials, account name, Minecraft login or
commands. An answered status ping alone does not prove a server accepts
connections. Even a successful offline handshake does not prove native
transport completion or a world join; compare with a normal Bedrock client
using the same network.

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
exits and Node schedules the next attempt on its fixed 15s timer — Node,
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

### Account automation system

Behaviors live in the Rust bot (`backend/rust-bot/src/behaviors.rs`) and are
driven from Azalea's game tick:

- **Crouch** – continuously hold sneak; recheck server input after home/TPA teleports and world changes without releasing the key
- **Auto-sell** – sell-menu cycle with bounded timeouts and recovery after teleports/world changes
- **Clean Spawner** – drop/sell the targeted spawner's contents per item type

They read a shared config that `{"type":"configure"}` updates live, so
toggling automation or changing intervals in the UI takes effect without
reconnecting.

The spawner sell button is located by item **name/lore keywords** because GUI
layouts differ per server and resource pack. A temporarily missing button is
retried several times before the run closes the menu and reports the failure.

### Feature visibility

Live inventory viewing, moving and dropping have been removed for all roles,
including admins, together with their API routes and bot protocol commands.
Balance polling, automatic home queries, home shortcuts, auto-home and
auto-TPA have been removed for all roles. Manually entered commands remain
available through the console.

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
a real player. The last 20,000 console lines per account are persisted to
SQLite and pruned automatically. The console initially loads 2,000 lines;
older history can be loaded in pages while keeping the reading position.

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
- Rate limiting: global (200 req/min) + strict login limiter
  (`LOGIN_RATE_LIMIT_MAX` per `LOGIN_RATE_LIMIT_WINDOW`)
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

This starts two containers:

- **backend** – the Fastify API + WebSocket server + all Minecraft clients
  (SQLite DB persisted in the `backend_data` volume). The image is built in
  multiple stages: a Rust nightly stage compiles the `azalea-bot` binary, a
  Node stage compiles the TypeScript, and the slim runtime stage bundles
  both. The first `docker compose build` therefore takes a few minutes while
  the Rust dependencies compile. Persistent BuildKit cache mounts retain the
  Cargo registry, git dependencies and compiled dependency artifacts, so later
  bot-source changes do not rebuild all of Azalea.
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
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) — V4.2.0 security findings,
  fixes, test evidence and unverified deployment boundaries.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — features that Azalea (Java-only,
  headless) cannot support: Bedrock accounts and rendered Live View / screenshots,
  with the path to add each later.
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
