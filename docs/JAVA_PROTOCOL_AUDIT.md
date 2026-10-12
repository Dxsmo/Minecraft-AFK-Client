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

Both failures were reproduced by regression tests before applying the fixes.
Both fixes apply with AutoSell disabled and in either network mode.

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
relative teleport movement and ordered acknowledgements, and all combinations
of relative rotation. Teleport replies already matched vanilla; its immediate
reply also uses both flags false and leaves periodic position/rotation caches
alone, so those behaviors were retained.

## Reproduce and limits

Download the reference above, verify its SHA-1, and use JDK 25 or newer:

```bash
javap -c -p -classpath /tmp/client-26.2.jar \
  net.minecraft.client.multiplayer.ClientPacketListener \
  net.minecraft.client.player.LocalPlayer \
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
