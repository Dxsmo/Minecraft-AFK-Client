# Azalea client network and inventory patches

`azalea-client` is copied from the same upstream revision as the other Azalea
dependencies: `6249c295` in https://github.com/azalea-rs/azalea. Its license is
included. The manifest resolves inherited workspace dependencies explicitly;
all Azalea dependencies still use that same pinned Git revision.

The network patch adds a public `NetworkConnection::try_read` method
delegating to the existing raw packet reader. It periodically removes consumed
buffer prefixes once they reach 64 KiB. Upstream only clears the buffer when
it is completely consumed; a continuous stream ending in partial frames can
otherwise retain the entire session's data. The unread decrypted tail, framing,
compression and cipher state are preserved. A real TCP regression exercises
8,193 ordered packets for each compression/encryption combination while every
batch ends inside the next packet. The AFK network plugin uses the reader to
bound incoming work without replacing compression, encryption or protocol
handlers. Upstream's private reader otherwise cannot be used by a custom
connection plugin. Cargo's patch applies to the client used by `azalea`.

`RawConnection::network_diagnostics` also exposes a nonblocking snapshot of
unread and total stored buffer bytes and outgoing packet/keepalive counts. The
writer records a completed packet only after `write_all` succeeds; the counters distinguish queueing from
handoff to TCP, and do not claim receipt or acknowledgement by the server.
Keepalive packets are identified by the pinned protocol's resource name rather
than hardcoded game/config packet IDs. Diagnostics carry no packet payloads.
The writer also retains the failed packet's resource name, I/O error kind and
OS error code. `poll_writer` remembers completion so callers can safely poll it
again while incoming disconnect frames are drained. The stock writer poller is
exposed for the simulation to disable the complete connection plugin, matching
production; leaving it enabled would bypass the AFK reader's drain policy.
The standard comparison reader now uses the same public `try_read` wrapper so
it also reclaims consumed buffer prefixes. Its raw packet handler silently skips
empty payloads, preserving valid one-byte bundle delimiters. It otherwise retains
Azalea's unbounded read-until-empty scheduling and normal packet callbacks.
`Simulation::new_with_plugins` accepts the production plugin group, allowing
both network modes to exercise their actual registration and wire behavior.

Keep the patch aligned with Azalea when changing its revision. Remove the local
copy if upstream exposes an equivalent nonblocking reader API.

Inventory content/slot handlers also apply state IDs and carried stacks in wire
order, before asynchronous bot callbacks. Player slots are mirrored between the
player inventory and the active container on each changed slot. This prevents
join-time restoration and farm pickups from leaving stale GUI contents or
rewinding click revisions. Mirroring one changed slot preserves other predicted
clicks until the server acknowledges them. Slot packets no longer require a
second bot callback; their synchronous ECS updates are sufficient.

Login and respawn handlers clear both `HasClientLoaded` and `InLoadedChunk`.
A proxy can send another game login without a respawn; retaining the old
client-loaded marker then suppresses `ServerboundPlayerLoaded` for the new
server. Clearing the chunk marker also prevents a same-batch position callback
from treating the previous world's chunk as a loaded destination. The existing
loading plugin sends one acknowledgement once the new chunk is usable.
Regression tests cover login → respawn → login, without acknowledging unloaded
chunks or sending the acknowledgement twice.
