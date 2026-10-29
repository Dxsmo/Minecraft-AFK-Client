# Azalea client network and inventory patches

`azalea-client` is copied from the same upstream revision as the other Azalea
dependencies: `0d38e0dcf47eb258c41b1b09ebc2bcde7253e185` in https://github.com/azalea-rs/azalea. Its license is
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

The bounded reader signals `PacketReadBacklog` when it exhausts its packet or
time budget. The shared ECS runner consumes that signal and yields to async
tasks before its next update, without an additional frame sleep. Commands,
packet callbacks and due 20 Hz game ticks still run between batches. An empty
socket clears the request, including while waiting for a bundle delimiter, so
idle sessions retain 60 Hz pacing. Update timestamps are recorded after sleeping
to avoid alternating delayed and immediate idle updates. The standard reader
does not request catchup and retains its read-until-empty behavior. Regression
tests exercise the actual scheduler, idle pacing, due ticks, ordered control
replies and clearing the request while an incomplete bundle waits for data.

`RawConnection::network_diagnostics` also exposes a nonblocking snapshot of
unread and total stored buffer bytes and outgoing packet/keepalive counts. The
writer records a completed packet only after `write_all` succeeds; the counters distinguish queueing from
handoff to TCP, and do not claim receipt or acknowledgement by the server.
Keepalive packets are identified by the pinned protocol's resource name rather
than hardcoded game/config packet IDs. Diagnostics carry no packet payloads.
The writer also retains the failed packet's resource name, I/O error kind and
OS error code, together with its age since enqueueing. Pong has its own queued
and completed counters. Successful keepalive/pong writes record their latest
and maximum enqueue-to-TCP duration in milliseconds; failed writes do not count
as completed replies. These local durations are not server acknowledgements or
round-trip measurements. `poll_writer` remembers completion so callers can safely poll it
again while incoming disconnect frames are drained. The stock writer poller is
exposed for the simulation to disable the complete connection plugin, matching
production; leaving it enabled would bypass the AFK reader's drain policy.
The standard comparison reader now uses the same public `try_read` wrapper so
it also reclaims consumed buffer prefixes. Its raw packet handler silently skips
empty payloads, preserving valid one-byte bundle delimiters. It otherwise retains
Azalea's unbounded read-until-empty scheduling and normal packet callbacks.
`Simulation::new_with_plugins` accepts the production plugin group, allowing
both network modes to exercise their actual registration and wire behavior.

Both readers also share a per-connection game bundle collector. Raw frames
between opening/closing delimiters remain invisible to ECS handlers and bot
callbacks until the closing delimiter arrives. The complete bundle is then
handled in wire order without yielding to movement/physics between its parts,
even when it exceeds the AFK update quota. The AFK filter still drops cosmetic
and item data before decoding the contained packets. Empty frames do not close
bundles. The collector follows vanilla's 4096-packet limit and rejects terminal
configuration transitions inside bundles with an explicit disconnect reason.
Invalid packet bodies retain the readers' existing error policy without losing
subsequent healthy packets in a completed bundle. Regression tests cover both
readers, split/adjacent/empty bundles, inventory and control ordering, rejected
bundles, the size limit, and one-byte TCP fragments with compression/encryption.
Disconnect snapshots report the number of completed bundles and whether a bundle
is still open, its age, the number/age of held keepalive and ping frames, and the
maximum completed bundle/control wait. Held controls remain unprocessed until
the delimiter; these counters identify raw packet types and do not imply a
successful body decode. Pending measurements clear on close, protocol changes
and invalid bundles. No packet payloads or extra routine console logs are added.
The AFK reader also reports its latest/maximum update gap and read work duration,
so a CPU/scheduling pause can be distinguished from waiting for a delimiter or
an outgoing socket write. Maxima cover the current connection's lifetime.

Game keepalive/pong replies now use the transport's Game protocol state rather
than the presence of the gameplay ECS marker. A missing marker previously
suppressed these replies despite an active Game transport. The normal guard is
retained for gameplay commands, and game control replies are blocked in other
transport phases. Terminal game acknowledgements retain their original path.
The real TCP regression covers present/absent markers in both readers, including
rejection of ordinary commands without the marker and of game controls during
configuration. This is a defensive correction; the user's reset log does not
establish that their ECS marker was absent.

Keep the patch aligned with Azalea when changing its revision. Remove the local
copy if upstream exposes an equivalent nonblocking reader API.

Inventory content/slot handlers also apply state IDs and carried stacks in wire
order, before asynchronous bot callbacks. Player slots are mirrored between the
player inventory and the active container on each changed slot. This prevents
join-time restoration and farm pickups from leaving stale GUI contents or
rewinding click revisions. Mirroring one changed slot preserves other predicted
clicks until the server acknowledges them. Slot packets no longer require a
second bot callback; their synchronous ECS updates are sufficient.

`set_player_inventory` is also applied synchronously. Its player-inventory
indices map to screen slots (hotbar 0–8 → 36–44, main inventory 9–35 unchanged,
armor 36–39 → 8–5, offhand 40 → 45), and shared player slots are mirrored into
the open container without changing its state ID. Body/saddle equipment has no
slot in the supported player menu. Each `MenuOpenedEvent` resets the menu state
ID and carried stack and advances `MenuSession`, including reused container
IDs. Automation checks that session before subsequent clicks or delayed closes;
it cannot apply an old slot cursor to a replacement screen while its bot callback
is still queued. Reference methods and regression coverage are recorded in the
Java protocol audit below.
The shared `set_cursor_item` handler also applies the server's carried stack
before the next click hash is constructed, without changing the menu state ID.

Login and respawn handlers clear both `HasClientLoaded` and `InLoadedChunk`.
A proxy can send another game login without a respawn; retaining the old
client-loaded marker then suppresses `ServerboundPlayerLoaded` for the new
server. Clearing the chunk marker also prevents a same-batch position callback
from treating the previous world's chunk as a loaded destination. The existing
loading plugin sends one acknowledgement once the new chunk is usable.
Regression tests cover login → respawn → login, without acknowledging unloaded
chunks or sending the acknowledgement twice.

Shared movement handlers now acknowledge server-forced rotations immediately
and track the last periodically reported on-ground and horizontal-collision
flags separately from intermediate physics state. This matches the official
26.2 client's behavior, including status-only collision transitions while
stationary. Flag history resets on login/respawn. The independent wire fixtures
and reference provenance are documented in
[`docs/JAVA_PROTOCOL_AUDIT.md`](../../../docs/JAVA_PROTOCOL_AUDIT.md).

The 2026-10-25 update rebases the client patch onto upstream `0d38e0dc`
(2026-10-16), including Bevy 0.20 and its updated dependency graph. Both readers
skip `server_data` before decoding: the headless client does not display its
MOTD/favicon, and proxy-specific invalid chat NBT must not count as a gameplay
read failure. Bundle collection still happens before the cosmetic filter.
Automation now shares a command budget with manual commands and `/sellmulti`.
It allows three immediate commands and refills one credit every 1.5 seconds;
auto-sell also has a minimum interval of 1.5 seconds. Credits survive settings
and world changes. Control replies are never subject to this chat budget.

The held mouse input added on 2026-10-29 retains `LeftClickMine` through world
transitions. Both automatic mining and mining progress ignore open container
screens (`Inventory.id != 0`), so held gameplay input cannot mine behind an
AutoSell or manual menu. The selected button resumes when the screen closes.
