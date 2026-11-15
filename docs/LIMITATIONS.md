# Current client limitations

Java uses Mineflayer 4.39.0 and Bedrock uses bedrock-protocol 3.60.1. Every
account runs in its own Node process. See [engine migration](ENGINE-MIGRATION.md).

- The installed Java codec supports up to 26.1 and matching release aliases;
  Bedrock defaults to 1.26.51. A version number is selectable only when an
  installed codec can implement it. Unknown newer protocols are never relabelled.
- Microsoft authentication, server rules, network outages and scheduled server
  restarts can interrupt connections. Automatic recovery cannot guarantee zero
  disconnects. Missing or incompatible caches need a new device-code sign-in.
- AutoSell, CleanSpawner and /desmo depend on the server's actual menu layout
  and item metadata. Actions use current menu identities and finite deadlines;
  unknown world data and replaced menus never become guessed targets.
- CleanSpawner requires an unobstructed spawner within reach. It never walks.
  With configured actions it preserves one stack of each selected item type.
- Held input follows game/server mining, attack and use limits and yields to
  foreground commands and container automation. Sneak checks never toggle off.
- Both editions request four chunks view distance. Server
  simulation distance and server-imposed view limits remain server-owned.
- Resource packs are accepted by the headless protocol clients. This does not
  provide graphics or support every custom resource-pack behavior. Live camera,
  manual movement and inventory-viewing APIs remain removed.
- CPU/RAM capacity must be measured on the actual Pi with the new engines;
  prior Azalea/shared-JVM measurements are historical.

Local verification uses synthetic accounts and isolated protocol fixtures. It
cannot establish long-running production Microsoft/Geyser compatibility or a
Pi capacity limit. Production deployment and production account tests are not
part of this local-only migration.
