# Known technical limitations

This project drives Minecraft bots with the [Azalea](https://github.com/azalea-rs/azalea)
Rust library (pinned to revision `6249c295`). Two requested features cannot be
implemented on top of Azalea as it exists today. Rather than shipping a
half-working or faked implementation, they are documented here together with
what *would* be required to add them later.

## 1. Minecraft Bedrock accounts (not supported)

**Status: not possible with the current stack.**

Azalea implements the **Java Edition** network protocol only. Bedrock Edition
uses an entirely different transport (RakNet over UDP) and a different protocol,
which Azalea does not speak. There is no Bedrock/RakNet client, encryption, or
login handshake anywhere in the dependency.

Consequences:

- A Bedrock account cannot connect through the existing Rust bot subprocess.
- Building a Bedrock client ourselves would mean implementing a full second
  protocol stack (RakNet + Bedrock login/Xbox Live auth + world/packet
  handling). That is a large, separate project and explicitly out of scope —
  the brief asks us **not** to ship a speculative half-implementation.

### How Bedrock could be added later

The architecture is already split so Bedrock support can be dropped in without
touching the Java path:

- **Data model** — `MinecraftAccount` carries a reserved `edition` column
  (`JAVA` by default). A future Bedrock integration would flip this to
  `BEDROCK` and branch on it.
- **Connection layer** — `MinecraftClient` (Node) spawns one bot subprocess per
  account and speaks a small NDJSON protocol to it. A Bedrock integration would
  provide an alternative subprocess binary (e.g. a Go/Node Bedrock client such
  as `gophertunnel`, or a future Bedrock-capable Rust crate) that speaks the
  **same** NDJSON protocol (`protocol.rs` / the event contract in
  `MinecraftClient.ts`). `ClientManager` would pick the binary based on
  `edition`.

Because the entire rest of the app (auth, accounts, console, WebSocket,
behaviors config, dashboard) talks to bots only through that NDJSON contract,
none of it would need to change — only a new edition-specific bot binary and the
`edition` branch in `ClientManager`.

The `edition` field is intentionally **not** exposed in the create/update API or
UI yet, so users cannot create accounts that would silently fail to connect.

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
