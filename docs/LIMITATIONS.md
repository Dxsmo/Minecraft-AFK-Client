# Known technical limitations

This project drives Minecraft bots with the [Azalea](https://github.com/azalea-rs/azalea)
Rust library (pinned to revision `6249c295`). Two requested features cannot be
implemented on top of Azalea as it exists today. Rather than shipping a
half-working or faked implementation, they are documented here together with
what *would* be required to add them later.

## 1. Minecraft Bedrock accounts (partially supported)

**Status: implemented via a separate Node bot, but not yet verified against a
live Bedrock server.**

Azalea implements the **Java Edition** network protocol only (RakNet/UDP Bedrock
is a different transport it does not speak). Rather than force Bedrock into
Azalea, Bedrock accounts run through a **second, independent bot subprocess**
built on the [`bedrock-protocol`](https://github.com/PrismarineJS/bedrock-protocol)
Node library. It speaks the **same NDJSON contract** as the Rust Java bot, so the
entire rest of the app (auth, accounts, console, WebSocket, behaviors config,
dashboard) is edition-agnostic.

### How it is wired

- **Data model** — `MinecraftAccount.edition` (`JAVA` default) is now exposed on
  account creation. It is write-once (not editable afterwards).
- **Connection layer** — `MinecraftClient` picks the bot launcher by edition:
  Java → the compiled `azalea-bot` binary; Bedrock → `node dist/bedrock-bot/index.js`.
  `ClientManager` sets `edition` in the runtime config.
- **Bedrock bot** — `backend/src/bedrock-bot/` (protocol/send/behaviors/index)
  mirrors the Rust bot: lifecycle, reconnect handoff, chat, health,
  auto-sell (owned container + acknowledged stack transfers), held crouch
  input, and centralized sell chat parsing.

### What works vs. what is limited on Bedrock

- **Implemented:** connect/login (offline + Microsoft device-code), chat/console,
  commands, interval auto-sell, crouch, health telemetry, sell chat parsing.
- **Connection:** always uses the configured public port instead of following
  a proxy's advertised internal port. Discovery, Microsoft authentication,
  transport, login and world initialization have separate bounded deadlines;
  cached-token refresh has at least 120 seconds, and device-code sign-in uses
  the supplied code expiry. After authentication the normal connect deadline
  resumes. Console messages identify each connection stage and explicit
  Bedrock login refusals (including incompatible protocol versions).
- **Crouch:** emits `player_auth_input` at 20 Hz with held sneak flags and the
  server's own player position; acknowledges teleport input and reasserts sneak
  after transfers and HugoSMP home/TPA confirmations. Only the local player's
  server metadata confirms crouch. Transfers/negative feedback and explicit
  restart checks resynchronize Geyser's cached shift with release and press in
  separate input ticks; normal held input stays pressed. Packet failures keep
  the resync pending for retry.
- **Auto-sell:** associates a chest-style container with its own `/sell` request,
  waits for container/inventory content, and moves occupied inventory/hotbar
  slots into empty container slots. Geyser chest titles also identify late or
  startup sell menus; manual GUIs remain excluded. Authoritative servers use `item_stack_request`
  with current stack IDs and matching response acknowledgements; legacy servers
  use `inventory_transaction` and inventory updates. Armor/offhand and foreign
  GUIs are excluded. Each cycle handles a bounded initial slot list; subsequent
  pickups are handled by the next cycle. Missing data/rejected requests time out,
  and manual commands can interrupt immediately. Manual commands pause automation
  for five seconds; named delayed sell replies are closed without touching a
  subsequently opened home menu. Custom form-based sell menus
  are not implemented.
- **Regression checks:** real installed Bedrock codecs for 1.21.50 and 1.21.130
  verify sneak, stack transfers, close ordering, timeout recovery, manual command
  priority, and selling during continuous join-time inventory updates.
- **Not available on Bedrock:** `clean_spawner` (emits a warning) and Live View
  screenshots (headless, same as Java — see §2).

### Build note (arm64)

`bedrock-protocol` pulls in `raknet-native`, which ships prebuilds for x64 only.
On arm64 (Raspberry Pi 5, Apple-Silicon Docker) it compiles from source, so the
backend image installs `cmake` + a C++ toolchain in the builder stage. This is
already handled in `backend/Dockerfile` and verified building on arm64.

### Caveat

The Bedrock bot compiles, boots inside the arm64 production image, loads native
RakNet, and fails gracefully (`connection_failed`) against an unreachable host —
but it has **not** been runtime-tested against a real Bedrock server. A live
connect should be verified before relying on Bedrock accounts in production.

The Bedrock input/GUI implementation follows Geyser's
[PlayerAuthInput handling and cached Java shift state](https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/session/cache/InputCache.java)
and [container title transport](https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/inventory/holder/BlockInventoryHolder.java).
The pinned local packet schemas and codec regression tests define the supported
wire shapes; these checks do not substitute for a live HugoSMP connection.

## Fixed view distance and server simulation distance

Java and Bedrock accounts always request a view distance of **6 chunks**.
This is fixed in the bot code, with no per-account or website override.
Java sends `ClientInformation.view_distance = 6`; Bedrock sets both the
`viewDistance` option and the client property read by the installed library's
`request_chunk_radius` handler. The server can impose a lower actual radius.

**Simulation distance cannot be locked to 6 by this client.** Neither the Java
client settings packet nor Bedrock's chunk-radius request exposes a client
setting that changes the remote server's simulation radius. Java server
operators configure `simulation-distance=6`; vanilla Bedrock server operators
configure `tick-distance=6`. On HugoSMP, this requires the server operator;
the website does not administer that server. There is no placeholder setting
claiming a simulation distance that the client cannot enforce.

References: [Java simulation-distance server property](https://feedback.minecraft.net/hc/en-us/articles/4409891990285-Minecraft-Java-Edition-Snapshot-21w38a),
[Bedrock server properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/server-properties?view=minecraft-bedrock-experimental),
[Bedrock chunk-radius packet](https://mojang.github.io/bedrock-protocol-docs/1.26.51/packets/request-chunk-radius-packet/).

## 2. Live View / automatic screenshots (not possible)

**Status: not possible with the current stack.**

Azalea is a **headless** client: it maintains world/entity state and the network
connection, but has **no renderer, framebuffer, camera, or GPU pipeline**. The
in-game screenshot keys (`F2`) and perspective toggle (`F5`) are features of the
*official rendering client* — they do not exist in a headless bot, because there
is no rendered frame to capture and no third-person camera to switch to.

Consequences:

- There is nothing to capture with `F2`, and no camera to cycle with `F5`.
- Producing an actual image would require rendering the world ourselves
  (loading block/entity models and textures and rasterising a scene from the
  bot's position) — effectively writing a Minecraft renderer. That is far beyond
  the scope of this service and would not reflect the "real client view" anyway.

### What is provided instead

The live, real bot state that *is* available is already surfaced elsewhere in
the UI and stays in sync with the server:

- Live console (chat + server messages + events) via WebSocket.
- Live status: connection state, health, food, reconnects.

If a rendered Live View is ever required, the realistic path is an **external
renderer**: run a separate, GPU-capable headless renderer (e.g. a containerised
official client or a project like `chunky`) fed by the bot's position/world,
and upload its output. That is a standalone component, not something Azalea can
do in-process.
