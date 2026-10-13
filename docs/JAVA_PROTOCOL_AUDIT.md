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
