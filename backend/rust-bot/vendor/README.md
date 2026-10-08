# Azalea client network and inventory patches

`azalea-client` is copied from the same upstream revision as the other Azalea
dependencies: `6249c295` in https://github.com/azalea-rs/azalea. Its license is
included. The manifest resolves inherited workspace dependencies explicitly;
all Azalea dependencies still use that same pinned Git revision.

The network patch adds a public `NetworkConnection::try_read` method
delegating to the existing raw packet reader. The AFK network plugin uses it to
bound incoming work without replacing compression, encryption or protocol
handlers. Upstream's private reader otherwise cannot be used by a custom
connection plugin. Cargo's patch applies to the client used by `azalea`.

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
