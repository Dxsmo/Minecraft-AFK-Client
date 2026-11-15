# Mineflayer / Bedrock engine migration

Java accounts use Mineflayer 4.39.0. Bedrock accounts use bedrock-protocol 3.60.1.
The backend supervises one isolated Node process per account over NDJSON, with
finite connection/heartbeat deadlines, staggered startup and reconnect backoff.
SoulFire, its SDK/RPC, dedicated JVM and input extension are no longer used.

## Existing installation

This change is prepared and tested locally; it does not deploy to the Pi.
When deploying later, keep the existing Compose project name and data volumes.
Before updating an installation still using the old engine, run that revision's
`scripts/backup-stack.sh` to archive both of its volumes. Then update the checkout
and run `bash scripts/update.sh`. All images build before any service is replaced.
The update removes orphaned containers, including the retired engine, without
deleting named volumes. Do not use `down --volumes` or delete the old data volume.

Account IDs, users, assignments, settings, images, earnings and console history
remain in the existing SQLite database. No account table is recreated. Active
intent is retained: accounts configured to resume reconnect after backend start.
Manual commands are never replayed automatically after reconnect.

The new engines persist private Microsoft caches below
`backend/data/bot-cache/<account-id>/` (inside `backend_data` with Docker).
Existing compatible Prismarine caches can be reused there. A controlled, one-time
import can also convert a private legacy Live token cache. Preserve its issuing
OAuth client: optional `microsoft-client.json` metadata contains only `clientId`;
the engines recognize Nintendo, Java/Win32 (Java only), and Android (Bedrock only).
Never relabel a refresh token as a different app. Legacy files are not imported
automatically by the engines. Revoked or incompatible tokens still require a new
device-code sign-in. Old files/volumes are left intact. Each edition authenticates independently.
Do not copy tokens between editions or publish cache files.

New complete backups archive the backend data directory, including SQLite and
all active Microsoft caches. Keep `.env` and any historical engine backups private.

## Runtime and features

- Node.js 24+ runs both engines. Docker includes the native RakNet dependencies;
  bare-metal installs need Python 3, make, a C++ compiler and CMake for native builds.
- The version endpoint reads installed codecs, without an RPC connection. Java
  auto-detects the advertised protocol; explicit release aliases resolve to the
  corresponding implemented codec. Unsupported versions fail explicitly.
- Both editions retain account control, Microsoft device-code login, console,
  manual commands, AutoSell/restart pauses, held input, crouch checks, /desmo and
  configured CleanSpawner actions. Menus and transfers have bounded deadlines.
- A stopped/replaced process is drained before the same account starts again.
  Backend shutdown waits for all retired children, escalating stuck processes.
- The shared-service failure mode is removed. A network/server failure can still
  disconnect an account; automatic reconnect follows its saved setting.

## Local validation

Run `npm run build` and `npm test` in `backend`, and `npm run build` in `frontend`.
Tests use isolated SQLite and local synthetic protocol fixtures. They do not
connect existing accounts to production servers. Server-specific menus and long
Microsoft/Geyser sessions still need verification on the target installation.

The local suite covers Java 1.16.5/26.1 world entry and command dispatch without
health packets, real isolated Java process startup/stop, a native Bedrock UDP
transport rejection, and serialized Bedrock held-input/inventory/spawner actions
through 1.26.51. This is not a successful production Bedrock/Microsoft login test.
Backend/frontend builds, the complete backend suite, shell/Compose validation
and the process sampler tests pass. Docker image execution could not be checked
on this Mac because its Docker daemon was unavailable.

Historical deployment and performance documents describe earlier engines; their
measurements and shared-JVM workarounds do not describe this runtime.
