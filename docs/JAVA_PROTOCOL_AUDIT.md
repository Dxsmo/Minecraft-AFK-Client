# Java protocol comparison, 2026-10-13

The native bot at Azalea revision `6249c295` uses Minecraft **26.2,
protocol 776**, in both optimized and standard network modes. A Java account's
`minecraftVersion` dropdown does not select a different native protocol.

The reference was Mojang's [official 26.2 client JAR](https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar),
obtained through the [official version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json).
Its SHA-1 is `2dc72797acbc1b63fc16a11c4ac393605f453754`. The embedded
`version.json` confirms protocol 776. No Minecraft account was connected.

## Confirmed differences corrected

- `ClientPacketListener.handleRotatePlayer` applies absolute/relative yaw and
  pitch and immediately sends a rotation packet with both movement flags false.
  Azalea's handler was empty. The shared handler now applies and acknowledges
  the correction, including vanilla's finite-angle and pitch normalization rules.
- `LocalPlayer.sendPosition` compares both on-ground and horizontal-collision
  flags against the last periodic report. Azalea checked only on-ground against
  an intermediate physics value, so stationary collision changes could be missed.
  The shared sender now keeps both reported flags separately from physics,
  resets them on world changes, and preserves the 20-tick position heartbeat.
- `PacketBundlePacker` holds game packets between bundle delimiters. Only the
  closing delimiter releases a `ClientboundBundlePacket`, which
  `ClientPacketListener.handleBundlePacket` handles in wire order without an
  intervening game tick. Azalea's delimiter handler was empty, and both readers
  applied incomplete bundles immediately. In particular, the AFK reader's update
  budget could yield between bundled world/inventory/position corrections.
  Both readers now collect bundles per connection across TCP reads and updates,
  and apply each completed bundle as one unit before yielding. The AFK item
  filter still runs before decoding each contained packet. Mojang's 4096-packet
  limit and rejection of `start_configuration` inside a bundle are enforced;
  invalid bundles disconnect with an explicit reason and discard held contents.
  Empty frames neither close bundles nor consume their packet limit.
  Disconnect diagnostics include completed and pending bundle counts, so a
  subsequent live report can establish whether this connection uses bundles.

The failures were reproduced by regression tests before applying the fixes.
The fixes apply with AutoSell disabled and in either network mode.

## Wire checks

All 141 clientbound and 69 serverbound game packet IDs match the official
`GameProtocols` registration order. The bundle delimiter's source name differs;
its ID does not. Independent byte fixtures check the following, without using
Azalea's decoder to construct expected replies:

| Serverbound packet | ID | Checked fields |
| --- | --- | --- |
| Accept teleportation | `00` | VarInt, including 127/128 and five-byte IDs |
| Client tick end | `0d` | No payload |
| Keepalive | `1c` | 8 bytes, including the sign bit |
| Move position | `1e` | Three big-endian doubles and flags |
| Move position and rotation | `1f` | Three doubles, two floats and flags |
| Move rotation | `20` | Two big-endian floats and flags |
| Move status | `21` | On-ground bit 0, horizontal-collision bit 1 |
| Pong | `2d` | 4 bytes, including the sign bit |

Incoming raw fixtures exercise both production readers: keepalive/ping echo,
relative teleport movement and ordered acknowledgements, all combinations
of relative rotation, and bundles split across updates or larger than the AFK
update quota. Tests check that partial bundles cannot change rotation/inventory
or emit control replies, then check ordered replies on closing. Real TCP tests
send bundle frames one byte at a time with compression off/1/64 and encryption
off/on, in both production modes, verifying that inventory remains unchanged
until the closing frame. Empty/adjacent bundles, the exact 4096-packet limit,
invalid bundles, and a malformed contained packet followed by a healthy
keepalive are covered. Teleport replies already matched vanilla; its immediate
reply also uses both flags false and leaves periodic position/rotation caches
alone, so those behaviors were retained.

## Reproduce and limits

Download the reference above, verify its SHA-1, and use JDK 25 or newer:

```bash
javap -c -p -classpath /tmp/client-26.2.jar \
  net.minecraft.client.multiplayer.ClientPacketListener \
  net.minecraft.client.player.LocalPlayer \
  net.minecraft.network.PacketBundlePacker \
  'net.minecraft.network.protocol.BundlerInfo$1$1' \
  net.minecraft.network.protocol.game.GameProtocols
cd backend/rust-bot
cargo +nightly test --bin azalea-bot protocol_compatibility
```

The corresponding tests are in `src/protocol_compatibility.rs`; neither
downloads nor credentials are needed to run them. The reference JAR is not
stored in the repository.

This comparison covers code and selected wire behavior. It does not prove that
these differences caused the reported server fallback, and does not validate
every packet handler. A simultaneous long-running comparison at the same farm
with the normal Minecraft client still requires a live user session. The
standard Azalea reader is useful for isolating the AFK filter, but shares these
protocol handlers and is not a replacement for that vanilla comparison.

## Reset diagnostics, 2026-10-14

A reported TCP reset while writing a pong included an open 762-packet bundle.
That count is below the official 4096-packet limit and does not by itself show
that the client exceeded a response deadline. A reset gives no Minecraft kick
reason and does not establish why the remote connection was closed.

Disconnect snapshots now include the age and held keepalive/ping counts of an
open bundle, maximum completed bundle/control waits, queued/written pong counts,
local enqueue-to-TCP timings, and AFK network update gaps/read work. These are
bounded counters/timestamps; packet bodies and control IDs are not logged. Failed
writes retain their enqueue age and never count as completed replies. Timing
maxima refer to the connection's lifetime, and successful TCP writes do not prove
server receipt. The bundle collector still waits for its closing delimiter.

A real TCP regression reproduces a 762-packet bundle in both production modes,
delays its closing delimiter, and checks that held controls are visible in the
diagnostics without early replies. It then verifies the exact high-bit keepalive
and pong bytes, in order and once each, with successful write counters. Existing
socket failure and compression/encryption tests cover preservation of failed
write diagnostics and byte framing.

The same TCP regression reproduced suppressed game keepalive/pong replies when
the transport remained Game but the internal gameplay ECS marker was absent.
The shared sender now uses the transport phase for those two control replies;
ordinary commands retain their gameplay guard and game controls cannot be sent
in Configuration. The terminal configuration acknowledgement keeps its existing
send path. This was tested with both marker states in both readers. Mojang's
`ClientCommonPacketListenerImpl.handlePing` sends its pong on the client thread,
and `handleKeepAlive` defers only for `RenderSystem.isFrozenAtPollEvents`, without
a loaded-world/gameplay-marker condition. These methods were inspected in the
same official 26.2 JAR with `javap -c -p`.

The user's reset log does not show whether the internal marker was absent or
any response deadline was exceeded. The sender correction and timing metrics
therefore do not establish that the live disconnect cause has been resolved.

## Bounded-reader scheduling, 2026-10-18

Spontaner's report shows 37/37 keepalive and 7462/7462 pong replies handed to
TCP, no read errors, and a maximum completed bundle/control wait of 3379 ms.
Those maxima span the connection; they do not locate that delay immediately
before the fallback or prove a server-side timeout. A completed write measures
time after enqueueing and does not include incoming queueing or bundle assembly.

The AFK reader previously yielded after its four-millisecond/packet budget,
then waited for the next fixed frame even if incoming traffic remained. The
standard reader does not impose those per-batch frame waits. Under sustained
traffic this can limit drain throughput and delay later control packets even
with prompt outgoing TCP writes. A production-runner regression reproduces
the extra frame sleeps between saturated four-millisecond batches before the
fix. The bounded reader now requests another update; the runner yields to async
tasks and continues without the frame sleep. Game ticks keep their independent
20 Hz schedule, and all normal update systems run between batches. An empty
reader clears the request and restores 60 Hz idle pacing. Incomplete bundles
remain atomic and do not cause busy-polling while awaiting more socket data.

This removes a reproduced client-side source of queueing. The supplied log
does not prove it caused this fallback. A live comparison after rebuilding is
still necessary to establish whether the reported disconnects are resolved.

## AutoSell packet correctness and pacing, 2026-10-18

The follow-up report supplies an explicit backend kick reason:
`You are sending suspicious packets.` Its snapshot has 27/27 keepalive and
4759/4759 pong writes, no unread bytes or read errors, and a maximum completed
bundle/control wait of 256 ms. This identifies a server rejection rather than
establishing a keepalive timeout. The report associates kicks with AutoSell;
the message alone does not identify the server plugin/check or its thresholds.

Three client behaviors were reproduced before correction:

- AutoSell sent all 36 occupied player-slot clicks in one tick. It now sends
  one click at least 100 ms apart, including across cycle boundaries, without
  replaying missed intervals after a stall. It reads slots/revisions anew before
  each click, visits each slot once, and closes after the final click. Commands,
  disabling automation and world transitions can still interrupt the sequence.
- The shared `set_player_inventory` and `set_cursor_item` handlers were empty.
  Direct cursor changes now update the carried-stack hash used by clicks.
  Direct player updates now use
  the actual player-inventory index mapping and synchronize the open menu's
  player slots, without changing its container revision.
- Opening a screen retained the previous menu's state ID and carried stack.
  New menus now start at state ID zero with an empty cursor. A synchronous
  `MenuSession` counter also invalidates pending automation clicks/closes when
  a screen is replaced, including reuse of the same numeric container ID.

The reference is the same official 26.2 JAR/SHA-1 above, downloaded and verified
again. `javap -c -p` confirms `ClientPacketListener.handleSetPlayerInventory`
calls `Inventory.setItem`, its equipment index map, and the fresh menu state in
`AbstractContainerMenu`'s constructor. `handleSetCursorItem` updates the current
menu's carried stack. `MultiPlayerGameMode.handleContainerInput`
predicts the clicked slots, compares before/after snapshots, and sends the
current container state ID, changed-slot hashes and carried-stack hash. The
packet codec was also inspected. The 100 ms automation interval is a client
rate bound, not a claim about vanilla timing or the server's protection limits.

Regression coverage includes both production readers for direct inventory
updates, cursor updates in real outgoing click packets, and fresh/reused screens;
full-inventory click spacing, stalled ticks,
live slot removals/revisions, and replacement screens before delayed callbacks;
and real TCP AutoSell packets using a newer server revision between clicks,
followed by manual commands cancelling the unsent remainder. These tests remove
reproduced client errors; resolving the live server rejection still requires
checking the rebuilt client against that server.
