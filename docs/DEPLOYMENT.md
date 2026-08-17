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

```bash
git clone <your-fork-or-repo-url> /opt/afk-service
cd /opt/afk-service
cp .env.example .env
nano .env   # fill in real SESSION_SECRET, INITIAL_ADMIN_PASSWORD, SITE_ADDRESS, PUBLIC_ORIGIN
```

Generate a strong session secret:

```bash
openssl rand -hex 32
```

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

The stack is configured with `restart: unless-stopped`, so both
containers automatically start again after a Raspberry Pi reboot (as long
as the Docker daemon itself is enabled, which `get.docker.com` does by
default: `sudo systemctl enable docker`).

## 5. Reverse proxy & HTTPS options

You have two supported options, pick one:

### Option A — Cloudflare proxies + terminates TLS ("Flexible"/"Full")

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

### Option B — Caddy provisions its own Let's Encrypt certificate

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

If you'd rather not use Docker:

```bash
cd /opt/afk-service/backend
npm ci --omit=dev
npm run build
npx prisma migrate deploy
sudo cp ../scripts/systemd/afk-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now afk-backend
sudo systemctl status afk-backend
```

For the frontend + reverse proxy, install Caddy as a system package
(`https://caddyserver.com/docs/install`) and point it at
`frontend/Caddyfile` after running `npm run build` in `frontend/` and
adjusting the `root` path to the built `frontend/dist` directory (instead
of `/srv`, since there's no Docker volume here). Enable it with
`sudo systemctl enable --now caddy`.

## 9. Backups

```bash
./scripts/backup-db.sh ./backups
```

Run this via cron for regular backups, e.g. nightly:

```cron
0 3 * * * cd /opt/afk-service && ./scripts/backup-db.sh /opt/afk-service/backups >> /var/log/afk-backup.log 2>&1
```

Restore with `./scripts/restore-db.sh <backup-file>` (stops the backend
first).

## 10. Updates

```bash
cd /opt/afk-service
git pull
docker compose build
docker compose up -d
docker compose logs -f backend   # confirm prisma migrate deploy applied cleanly
```

Always back up the database before updating (`scripts/backup-db.sh`), in
case a schema migration needs to be rolled back.

## 11. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `docker compose up` fails building `backend` (argon2) | Native module build tools missing — the provided `Dockerfile` installs `python3 make g++` in the build stage; if building outside Docker, install those manually. |
| `npm install`/`docker compose build` fails fetching `mineflayer` | The backend pins Mineflayer to a specific GitHub commit (see README "Mineflayer version pin") instead of an npm version — this requires outbound network access to `github.com` during install/build, in addition to the npm registry. If your build environment blocks direct git access, this step will fail. |
| Login always returns 401 | Check `SESSION_COOKIE_SECURE` — if `true` but you're testing over plain HTTP, the cookie won't be sent back. Use `false` only for local HTTP dev. |
| `403 Invalid or missing CSRF token` | The frontend must read the non-HttpOnly `afk_csrf` cookie and send it as `x-csrf-token` on mutating requests — this is already handled by `frontend/src/lib/api.ts`; if calling the API directly (e.g. via curl), you must do the same. |
| Bot immediately disconnects with `RECONNECTING` looping | Check `serverHost`/`serverPort`/`minecraftVersion` match the target server; view the account's console for the exact kick/error reason. |
| `Server version 'X' is not supported` | Mineflayer doesn't yet support that Minecraft version. Check the README's "Mineflayer version pin" section for how to update to a newer commit that adds support, if one exists upstream. |
| Bot gets stuck on `CONNECTING...`/`RECONNECTING` past "Server requested a resource pack" with no further progress, even with a supported version | Likely an anti-bot/verification system on the server holding automated clients in limbo — not fixable client-side. See the README's "Mineflayer version pin" section for details. |
| Bot can run `/gamemode` etc. but not other commands | Expected — the Minecraft server's own permission system still applies; grant the bot account OP or the relevant permission-plugin node on the server side. |
| Caddy won't issue a certificate | Ports 80/443 must be reachable from the internet for HTTP-01 challenge, or use Cloudflare DNS-01/Origin Certificate instead (see section 5). |
| High memory usage on the Pi | Each connected Mineflayer bot uses a modest but non-trivial amount of memory; on 8 GB you can comfortably run several dozen bots, but monitor via `/api/system/status` and `docker stats`. |
