# Deployment Guide — Raspberry Pi 5 + Cloudflare

This guide covers taking the service from "runs on my laptop" to a
production deployment on a Raspberry Pi 5 (8 GB), reachable over HTTPS on
your own domain via Cloudflare.

## 1. Raspberry Pi OS setup

1. Flash **Raspberry Pi OS Lite (64-bit)** to an SD card / SSD (SSD boot
   strongly recommended for reliability + Minecraft/DB I/O).
2. Enable SSH, set a strong password, and update the system:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo reboot
   ```
3. Create a dedicated, unprivileged user for the service (skip if using
   Docker only, still recommended for the systemd fallback):
   ```bash
   sudo adduser --system --group --home /opt/afk-service afkservice
   ```

## 2. Installing Docker (recommended path)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# log out/in for the group change to apply
docker compose version
```

## 3. Getting the code onto the Pi

Prefer Git so generated development files are never transferred:

```bash
git clone <your-fork-or-repo-url> /opt/afk-service
cd /opt/afk-service
cp .env.example .env
nano .env   # fill in real SESSION_SECRET, INITIAL_ADMIN_PASSWORD, SITE_ADDRESS, PUBLIC_ORIGIN
```

Do **not** copy the complete development directory with Finder or `scp -r`.
Local `node_modules`, `dist`, `backend/rust-bot/target`, databases and IDE files
can be several gigabytes and are not needed by Docker. If Git cannot be used,
sync only non-ignored source files from the repository root:

```bash
rsync -az --delete --filter=':- .gitignore' --exclude='.git/' ./ \
  <pi-user>@<pi-host>:/opt/afk-service/
```

Files excluded by `.gitignore` (including the Pi's `.env` and database data)
are protected from this rsync deletion.

Generate a strong session secret:

```bash
openssl rand -hex 32
```

Set the browser-facing origin explicitly. For example, for
`https://afk.example.com`, use:

```dotenv
PUBLIC_ORIGIN=https://afk.example.com
CORS_ORIGINS=https://afk.example.com
SESSION_COOKIE_SECURE=true
TRUSTED_PROXIES=loopback,uniquelocal
```

Website sockets reject missing/untrusted Origins; browser write requests use
the same allowlist. Include only actual trusted origins, without wildcards.
`TRUSTED_PROXIES` applies to the backend's immediate proxies; narrow it to the
actual internal proxy addresses where practical. Separately configure Caddy's
trusted proxies for your Cloudflare/tunnel setup and verify that login limits
see visitor IPs rather than one shared proxy IP. See [SECURITY.md](SECURITY.md).

## 4. Running with Docker Compose

```bash
docker compose build
docker compose up -d
docker compose logs -f backend
```

Verify:

```bash
curl -s http://localhost/api/health
# {"status":"ok"}
```

The stack is configured with `restart: unless-stopped`, so all three
containers automatically start again after a Raspberry Pi reboot (as long
as the Docker daemon itself is enabled, which `get.docker.com` does by
default: `sudo systemctl enable docker`).

## 5. Reverse proxy & HTTPS options

You have three supported options, pick one:

### Option A — Cloudflare Tunnel (recommended for a home Raspberry Pi)

No router port forwarding and no public/static IP required (works behind
CGNAT / DS-Lite). Cloudflare reaches the Pi through an outbound-only
connection and terminates HTTPS for you.

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels →
   Create a tunnel** (type: *Cloudflared*). Name it e.g. `afk` and copy
   the **connector token** it shows.
2. Add a **Public Hostname** to the tunnel:
   - Subdomain: leave empty for the root, or e.g. `afk`
   - Domain: `desmo.club`
   - Service: **`HTTP`** → URL **`web:80`**
3. On the Pi, put the token into `.env`:
   ```bash
   TUNNEL_TOKEN=eyJ...your-token...
   SITE_ADDRESS=:80
   ```
4. Start the stack with the tunnel profile:
   ```bash
   docker compose --profile tunnel up -d
   docker compose logs -f cloudflared   # should show "Registered tunnel connection"
   ```
   The `cloudflared` container has `restart: unless-stopped`, so it also
   comes back automatically after a reboot.

### Option B — Cloudflare proxies + terminates TLS ("Flexible"/"Full")

1. In Cloudflare DNS, add an `A` record for your subdomain (e.g. `afk`)
   pointing at your home/router's public IP, with the orange cloud
   (proxied) enabled.
2. Forward ports `80` (and `443` if using Full mode) from your router to
   the Raspberry Pi's local IP.
3. Set `SITE_ADDRESS=:80` in `.env` so Caddy just serves plain HTTP
   locally; Cloudflare handles HTTPS for visitors.
4. **Full (strict)** mode (recommended over Flexible): generate a
   Cloudflare **Origin Certificate** (Cloudflare dashboard → SSL/TLS →
   Origin Server), and configure Caddy to use it instead of `:80` — see
   the commented example in `frontend/Caddyfile`. This keeps the
   Cloudflare↔Pi hop encrypted too (Flexible mode does not).

### Option C — Caddy provisions its own Let's Encrypt certificate

1. Set Cloudflare DNS to **DNS only** (grey cloud) for the subdomain, or
   use Cloudflare's "Full (strict)" + origin cert as above if you still
   want Cloudflare's proxy/CDN features.
2. Forward ports `80` and `443` to the Pi.
3. Set `SITE_ADDRESS=afk.example.com` in `.env` (your real domain). Caddy
   automatically requests and renews a Let's Encrypt certificate.

> **Important:** Cloudflare alone is not a complete security solution.
> The Raspberry Pi itself must still be hardened (firewall, SSH keys,
> automatic updates) — see below.

## 6. Firewall

Use `ufw` to only expose what's needed:

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do **not** expose port `4000` (the backend) directly — it should only be
reachable from the `web`/Caddy container over the internal Docker network,
which is already the case with the provided `docker-compose.yml` (no
`ports:` mapping for `backend`, only `expose` via the internal network).

Additional hardening:

- Disable SSH password auth, use key-based auth only
  (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- `sudo apt install unattended-upgrades` for automatic security patches.
- Keep Docker images updated (see "Updates" below).

## 7. Auto-start after reboot

Docker Compose containers with `restart: unless-stopped` come back up
automatically once the Docker daemon starts, and the daemon itself starts
on boot via systemd (`docker.service` is enabled by the official install
script). No extra steps needed. Verify with:

```bash
sudo systemctl is-enabled docker
sudo reboot
# after it comes back up:
docker compose ps
```

## 8. Non-Docker fallback (systemd)

If you'd rather not use Docker, install Java 25 first and prepare the dedicated
runtime/input extension as described in [SoulFire migration](SOULFIRE-MIGRATION.md).
The systemd units expect the JAR in `soulfire-runtime/`, the data directory in
`soulfire-data/`, and both owned/writable by `afkservice`. In `backend/.env` set
`SOULFIRE_URL=http://127.0.0.1:38765` and
`SOULFIRE_SECRET_KEY_FILE=/opt/afk-service/soulfire-data/secret-key.bin`.


```bash
cd /opt/afk-service/backend
npm ci
npm run build
npm prune --omit=dev
npx prisma migrate deploy
sudo cp ../scripts/systemd/afk-backend.service ../scripts/systemd/afk-soulfire.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now afk-soulfire afk-backend
sudo systemctl status afk-backend
```

For the frontend + reverse proxy, install Caddy as a system package
(`https://caddyserver.com/docs/install`) and point it at
`frontend/Caddyfile` after running `npm run build` in `frontend/` and
adjusting the `root` path to the built `frontend/dist` directory (instead
of `/srv`, since there's no Docker volume here). Enable it with
`sudo systemctl enable --now caddy`.

## 9. Backups

Use a complete backup before updates:

```bash
cd /opt/afk-service
bash scripts/backup-stack.sh
```

This stops/resumes the account services for a consistent snapshot and archives both website data
and SoulFire data with private file permissions. A database-only backup omits
Microsoft authentication caches and the SoulFire signing key. Keep `.env`
separately. See [the migration guide](SOULFIRE-MIGRATION.md).

## 10. Updates

```bash
cd /opt/afk-service
git pull --ff-only origin master
bash scripts/backup-stack.sh
bash scripts/update.sh
docker compose logs --tail=100 backend soulfire
```

All images build before any running container is replaced. SQLite migrations
run at backend startup. Existing volumes and account IDs remain in place. The
old `update-bedrock.sh` filename forwards to the complete update; it no longer
retains an Azalea binary. Cold SoulFire builds/startups download the pinned
release and Minecraft libraries; allow several minutes. Subsequent updates
reuse Docker/download caches. The website no longer builds Rust.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| SoulFire is not healthy yet | Allow its initial verified runtime downloads to finish; inspect `docker compose logs soulfire`. |
| SDK connection/authentication fails | Check the private `SOULFIRE_URL` and read-only signing-key mount; do not expose RPC publicly. |
| An old account requests a device code | Its original cache was missing/rejected or incompatible. Account settings/history remain; complete one new Microsoft sign-in. |
| Bedrock version rejected | This pinned engine exposes 1.26.51. Check server compatibility and the account's endpoint. |
| Companion account cannot join | The default is the same host with Java 25565 / Bedrock 19132; correct custom endpoints in its settings. |
| Held inputs do nothing | Confirm `afk-service-controls` is listed at SoulFire startup; Docker installs it in `/data/minecraft/mods`. |
| Login cookie absent over local HTTP | Use `SESSION_COOKIE_SECURE=false` only for local HTTP development. |
| CSRF rejected | Website writes need the current `afk_csrf` cookie echoed in `x-csrf-token`. |
| High memory usage | Measure real accounts and set `SOULFIRE_JAVA_OPTIONS` together with backend/OS headroom; old Azalea capacity estimates do not apply. |

The systemd fallback additionally needs a Java 25 SoulFire service and its input
extension. Configure `SOULFIRE_URL` and `SOULFIRE_SECRET_KEY_FILE` in the backend
environment and give its service user read access to the signing key. See the
[local runtime instructions](SOULFIRE-MIGRATION.md).
