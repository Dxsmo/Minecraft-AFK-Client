# SoulFire migration

The active Java and Bedrock controllers now use SoulFire **2.10.6** through its
matching TypeScript SDK. Docker Compose adds `afk-soulfire`; the website and
its database remain in the existing backend/web containers. All account controllers
share the backend Node runtime; no extra Node worker/process is started per account. The old Rust and
Bedrock source trees remain as reference, including earlier local work; they
are not launched or installed as production clients. No Rust build is needed.

## Updating an existing Raspberry Pi installation

From the existing checkout, after transferring/pulling these changes:

```bash
cd /opt/afk-service
bash scripts/backup-stack.sh
bash scripts/update.sh
```

The backup stops and resumes the account services for a consistent snapshot. It saves the full
website data directory (SQLite, logs and previous authentication caches) and
the SoulFire data volume. Keep these private archives along with your `.env`;
a database-only backup is insufficient to preserve Microsoft authentication.
Do not remove Docker volumes. The update builds all three images before
replacing containers; a build failure leaves the running installation intact.
`update-bedrock.sh` forwards to the same complete update for compatibility.

After updating from the original inventory-polling adapter, use
`bash scripts/update.sh --recreate` once. It builds first, then recreates the
runtime/backend/web containers to release previously allocated native renderer
caches. Named volumes, account settings and Microsoft login caches are retained.

The first SoulFire build downloads a roughly 400 MB release and compiles the
small input extension using Java 25. The first startup also downloads and
verifies Minecraft/runtime libraries. Allow several minutes and internet
access. The build supports the upstream Linux amd64/arm64 runtime. The release
JAR and all extension compiler dependencies are checked against their SHA-256
hashes. The SoulFire RPC port is private to the Compose network.

## Existing accounts and Microsoft sign-in

Account IDs, ownership, assignments, settings, images, earnings and console
history stay in SQLite. Existing auto-start choices are retained. New schema
columns do not recreate or rename any existing account.

On first use, the adapter imports the previous Azalea `azalea-auth.json`, or
Prismarine Live/MSAL refresh-token cache, using the original issuing OAuth
client and scope. SoulFire validates the resulting authentication chain. It
then stores the mapping and refreshed account in its own persistent volume.
Original cache files are left intact.

A valid, accepted refresh token can avoid another device-code login. This
cannot be promised for every account: revoked, missing or incompatible tokens
need one Microsoft device-code sign-in. Subsequent connections refresh the
SoulFire account normally. Stop/reconnect cleanup and backend startup
reconciliation prevent unattended bots remaining in the shared JVM after a
controller crashes.

## Independent edition sign-in

Each website account signs in only to its selected Java or Bedrock edition.
There is no opposite-edition discovery, token sharing, automatic counterpart
creation, or cross-edition status message. Add each edition separately through
its own Microsoft device-code sign-in. Existing accounts, including any created
by the former pairing feature, remain independent and retain their login caches,
settings, permissions and history. A migration removes only the retired pairing
metadata columns.

## Feature mapping

- Live Cam uses SoulFire's native POV stream for the selected account only:
  640×360 PNG frames, 48-block view distance and a minimum 400 ms interval
  between renders. It starts after website account authorization and shares one
  upstream stream across that account's viewers. Closing the tab/socket stops
  rendering when the last viewer leaves. Hidden browser documents disconnect;
  reconnecting/offline bots wait until online. Slow clients drop frames instead
  of queuing images, and current account permissions are checked before delivery.
  The camera component is a separate frontend chunk loaded on demand. Native
  renderer caches can remain allocated in the shared JVM after rendering stops.
- Java and Bedrock share the same scheduler for commands, AutoSell, `/desmo`
  multiplier tooltips and CleanSpawner. Clicks carry SoulFire's current menu
  identity. Inventory/menu/tooltip data comes from `watchBotEvents` with
  `includeInventory`; those events do not render item icons. Background
  automation never calls the icon-rendering `getInventoryState` RPC. Dropped
  event resynchronization invalidates cached menus until a new inventory arrives;
  an unexpectedly closed event stream ends the session for reconnection.
  Transfers wait for changed slots or a matching server payout (including
  immediately refilled stacks). The 10-second opening deadline ends once the
  menu opens; active sales have a separate finite progress budget. Manual
  commands take priority, close the active menu once, and identify failed sends
  without automatically repeating a potentially already executed command.
- World/position changes discard stale sale tasks and use finite retry
  deadlines. Restart announcements pause selling 10 seconds beforehand and
  resume **2 minutes after** the announced restart. The supervisor retains the
  deadline across reconnects.
- Sneak checks only assert sneak; they never toggle it off and emit no check
  log messages. Home/TPA/position transitions schedule an extra check after
  3 seconds. Existing periodic/restart checks remain.
- Auto button Off/Left/Right is mutually exclusive and persists in SQLite.
  The Java extension holds the native Minecraft use/attack/shift mappings on
  the game thread, also protecting held mappings against menu/focus releases.
  It works without a POV/video connection. Vanilla/server attack, use and
  mining cooldowns still apply; container screens route input to their menus.
- Login burst limits are twice the configured legacy base (default 5 → 10 per
  minute). The global API allowance changes from 200 → **400 per minute**.
  The separate persistent failed-login IP-ban policy remains in effect.
- All **1,489** ZIP PNGs are in the account-image chooser: searchable, A–Z,
  original transparency, filenames displayed with spaces instead of `_` and
  without `.png`. Choices use the existing image permissions and broadcasts;
  custom uploads remain available. Public item PNG loads are rate-limit exempt.

## Protocol and deployment limits

The version selector reads the installed SoulFire/ViaVersion definitions.
Java auto-detection uses a bounded status ping (including SRV records). Java
release aliases map to their actual codec. If a ping is unavailable, the
latest installed Java codec is used; an unsupported advertised protocol gives
a clear error instead of pretending to support it.

This pinned SoulFire release exposes **Bedrock 1.26.51 only** through
ViaBedrock. An older stored Bedrock selection remains in the database, but the
adapter reports and uses the supported replacement. Servers requiring another
Bedrock protocol need a compatible SoulFire/ViaBedrock release. Bedrock menus
and items are translated upstream; compatibility with every custom server menu
cannot be inferred solely from the Java integration fixture.

The shared JVM has a different resource profile from Azalea. Previous Pi
account-capacity measurements do not establish SoulFire capacity. Configure
`SOULFIRE_JAVA_OPTIONS` (for example `-Xms512m -Xmx4g -XX:+UseG1GC`) alongside
backend/web/OS memory, and measure real accounts before choosing a capacity.
This is a deployment setting, not a memory reservation per account.

For local development, run the dedicated JAR with Java 25 in its own directory,
put the built input extension in `<directory>/minecraft/mods/`, and set:

```bash
export SOULFIRE_URL=http://127.0.0.1:38765
export SOULFIRE_SECRET_KEY_FILE=/absolute/path/to/soulfire-data/secret-key.bin
```

Compile the extension with `python3 soulfire/build-plugin.py --soulfire-jar
/path/to/SoulFireDedicated-2.10.6.jar --output
/path/to/soulfire-data/minecraft/mods/afk-service-controls.jar`. Set `JAVA_HOME`
to a Java 25 JDK. Keep the RPC service and its root signing key private.
For systemd, run SoulFire alongside the backend and allow its service user to
read the key. Docker Compose configures these mounts and dependencies itself.

### Local connection timeouts

A successful Microsoft approval does not establish Minecraft TCP/UDP reachability.
When game connections time out, compare a direct connection from the host with
the container connection before changing the saved server address or tokens.
Java needs outbound TCP to the configured/SRV port; Bedrock needs outbound UDP.
A VPN or firewall can allow Microsoft HTTPS while blocking those game ports.
Test the same server with the normal Minecraft client and, where appropriate,
with the VPN disconnected. Do not silently change the user's system VPN or routes.

RPC/network/auth timeouts and temporary service failures do not invalidate saved
Microsoft accounts or start another device-code sign-in. Only an explicit
provider rejection (such as `invalid_grant` or a revoked refresh token) permits
that fallback. `fetch failed` can also mean the shared SoulFire process is
unavailable/restarting; check its logs, memory and restart count before replacing
account credentials. A simulation on a development host cannot establish Pi
capacity or prove why an unavailable production container stopped.

### Slow ARM resource loading

SoulFire 2.10.6 has a [hard-coded 30-second deadline](https://github.com/soulfiremc-com/SoulFire/blob/2.10.6/mod/src/main/java/com/soulfiremc/mod/mixin/soulfire/lifecycle/MixinMain.java) for the base Minecraft
resource/model load. On a Raspberry Pi this can expire even while the texture
atlases are still being created. The controls extension increases only that
deadline to 300 seconds; the original readiness checks and failure remain.
The log confirms the effective value with `Initial Minecraft resource load
timeout: 300 seconds`. A JVM property, `-Dafk.initialClientLoadTimeoutSeconds`,
can set a value between 30 and 1800 seconds if needed.

Compose allows a 15-minute startup period for downloads and initialization;
the update script waits up to 20 minutes for the full stack. Healthy services
are available immediately rather than waiting for those periods to expire.
If resource loading still fails, inspect `docker logs afk-soulfire`; increasing
only the Docker healthcheck would not fix the internal JVM deadline.

Validated in an isolated Linux ARM64 container with a test-only Fabric mixin
holding `isGameLoadFinished()` false for 35 seconds: a 30-second override
reproduces the reported exception, while the default 300 seconds reaches
`/health` with `{"healthy":true}`. Normal startup also passes without the test
mixin. The fixture uses a separate empty data volume; it is not shipped in the
production image. This simulates a slow load rather than measuring a real Pi.

SoulFire is [AGPL-3.0](https://github.com/soulfiremc-com/SoulFire/blob/2.10.6/LICENSE).
The input extension's complete source and reproducible build are in `soulfire/`.

## Reproducing the local integration check

After building the backend and starting an isolated SoulFire service with the
input extension, install `minecraft-protocol` in a temporary development folder
and run the fixture (it creates only temporary offline accounts):

```bash
cd backend
npm run build
MINECRAFT_PROTOCOL_MODULE=/path/to/node_modules/minecraft-protocol \
  node scripts/smoke-soulfire.mjs
```

Set `SOULFIRE_URL` and `SOULFIRE_SECRET_KEY_FILE` first. The fixture checks two
controllers in one Node process, Java auto-detection, native right use, native
left mining, no unsneak packet through a teleport/check, view distance six,
confirmed sale clicks and independent stop. Temporary SoulFire instances and
files are removed afterwards. Authentication import tests also validate the
original OAuth application/DER key format; an offline parser check accepted
both chains using the release's actual MinecraftAuth Java classes.

The image chooser's desktop/mobile browser check is
`scripts/ui/account-item-picker-check.mjs`, using an installed Playwright via
`PLAYWRIGHT_MODULE` and a Vite server via `UI_URL`.

The same fixture also passed inside the built Linux ARM64 stack, together with
website login through Caddy, authenticated SDK access over the private volume/
network and the complete item catalog. Production Microsoft credentials and
the actual Bedrock server were not available for a live test.

Set `AFK_SMOKE_REFILL_SALES=1` for the sale regression variant: all three stacks
are immediately replenished before the next tick, and a real server chat payout
confirms each transfer. The fixture checks the slot sequence, no AutoSell warnings,
manual command delivery, teleport/sneak handling, and zero inventory-render/POV
RPCs during automation. This Java protocol fixture exercises the common scheduler;
it does not certify a particular external Bedrock server's behavior.
