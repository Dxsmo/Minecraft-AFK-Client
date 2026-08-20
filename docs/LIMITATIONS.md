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
  mirrors the Rust bot: lifecycle, reconnect handoff, chat, health, auto-command,
  auto-sell (command-based), AFK swing, crouch, tpa auto-accept, balance/sell
  chat parsing, and a best-effort inventory snapshot.

### What works vs. what is limited on Bedrock

- **Works (same as Java):** connect/login (offline + Microsoft device-code),
  chat/console, commands, auto-command, interval auto-sell, AFK swing, crouch,
  tpa auto-accept, health telemetry, balance/sell chat parsing.
- **Best-effort / unverified:** live inventory snapshot and drag-and-drop item
  moves (uses `ItemStackRequest`; item names fall back to `bedrock:<id>` because
  there is no bundled Bedrock item palette).
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
- Live status: connection state, health, food, balance, reconnects.
- Live inventory tab (see feature #10) renders the bot's **actual** inventory
  contents (slots, stack sizes, hotbar) read from the open menu — this is the
  closest faithful "view" a headless client can provide.

If a rendered Live View is ever required, the realistic path is an **external
renderer**: run a separate, GPU-capable headless renderer (e.g. a containerised
official client or a project like `chunky`) fed by the bot's position/world,
and upload its output. That is a standalone component, not something Azalea can
do in-process.

## 3. Live inventory item textures (partial)

**Status: functional, but without item icons.**

The live inventory tab (feature #10) reflects the bot's **real** inventory —
slot contents, stack sizes, hotbar, armor and off-hand — and drag-and-drop moves
and drops are executed on the server through the bot. What it cannot show are the
official **item textures**: this project bundles no Minecraft texture assets
(they are Mojang-copyrighted and are not redistributed here). Each slot therefore
renders the item id and stack count on a deterministic per-item colour instead of
an icon. Dropping in a texture atlas later (or wiring up a resource-pack loader)
would be a purely cosmetic, additive change to `InventoryPanel.tsx`.

