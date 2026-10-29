# Current client limitations

Java and Bedrock now use SoulFire 2.10.6. See
[the migration guide](SOULFIRE-MIGRATION.md) for account retention, deployment
and the complete automation mapping. Previous implementation notes are in
[the historical archive](legacy/AZALEA-BEDROCK-NOTES.md).

- **Bedrock protocols:** this release exposes ViaBedrock 1.26.51 only. Java
  supports the release codecs listed by the running SoulFire instance.
- **Microsoft login:** accepted refresh-token caches can migrate silently.
  Missing, revoked or incompatible tokens need a new device code. Discovering
  the other edition uses the same login, but can fail for missing ownership,
  Xbox profile setup or authentication restrictions. It never creates an
  unauthenticated placeholder.
- **Companion endpoints:** automatically added accounts use the same hostname
  with the other edition's standard port. Different server endpoints must be
  configured on that account afterwards.
- **Menus and game actions:** the common scheduler uses SoulFire's authoritative
  inventory state and menu IDs. Bedrock custom-menu/item compatibility also
  depends on ViaBedrock. Vanilla/server attack, use, mining and command limits
  still apply even when an input key stays held continuously.
- **Distance:** the client requests six chunks. A remote server can clamp that
  radius and controls its own simulation distance; the website cannot enforce
  a server simulation radius.
- **Resource packs:** SoulFire provides its own headless resource-pack handling.
  That does not establish support for every custom pack or server behavior.
- **Screenshots/live view:** SoulFire has renderer/POV APIs. This migration
  does not add a streaming player or automatic screenshot UI. A later UI can
  use those APIs with the existing account permissions and resource limits.
- **Capacity:** all controllers share Node and one JVM, but this engine's CPU/
  RAM profile differs from Azalea. Historical capacity estimates do not carry
  over automatically.

Validation covers the website, mocked authentication/automation contracts,
native extension compilation/loading and real SoulFire connections against
an isolated Java protocol fixture. All three ARM64 Docker images built and the
isolated Linux stack passed website login, private RPC authentication, version/
item catalogs and the two-client input/selling/stop fixture. A production
Microsoft login, the actual Bedrock server and long-running behavior/capacity
on the Raspberry Pi still require deployment verification. No live production
accounts were used in these local checks.
