# Website security

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the dated code review and test
results. These describe verified application behavior, not a guarantee about a
deployed server or the absence of all bugs.

## Authentication and permissions

- Website passwords use Argon2id. Unknown usernames also perform password
  verification; login failures have generic responses.
- Opaque server-side sessions use HttpOnly, SameSite=Lax cookies.
  `SESSION_COOKIE_SECURE=true` is required for public HTTPS use. Logout,
  password changes and administrative resets revoke sessions.
- Website writes require the session's CSRF token. Browser write requests and
  website sockets check an explicit Origin allowlist from `PUBLIC_ORIGIN` and
  `CORS_ORIGINS`.
- Admins intentionally manage all Minecraft accounts. Other users can read and
  operate assigned accounts. Creators with revoked access cannot restore their
  own assignment.
- Sockets filter initial snapshots and live events, rechecking current session
  and permissions for queued actions. Logout/session-reset events close sockets
  immediately; idle sockets validate every 15 seconds. Commands, message size,
  pending work and send buffers have limits.
- Notes are private until shared, including against other admins. Read-only
  recipients cannot write; only the creator changes sharing or deletes a note.
  Usernames/IDs are intentionally available in sharing pickers.
- Minigame players use a separate Minecraft-identity challenge and bearer
  authentication; website admin routes still require an admin session.

## Data and browser protections

Public response selectors exclude password hashes and legacy Minecraft
credential fields. React escapes user text. Notes validate document structure,
link protocols and alignment server-side. Account icons and minigame photos
accept bounded PNG uploads that are checked and re-encoded, excluding SVG/HTML.
Prisma parameterizes application queries; deployment migrations use static SQL.

Name Sniper proxy settings use AES-256-GCM encryption in the database. Set a
dedicated `ENCRYPTION_KEY`; rotating it requires re-entering proxy settings.
Audit details recursively redact secret-bearing fields. Migration
`20261008180000_redact_proxy_audit_secrets` scrubs proxy values from old affected
audit records. It does not rewrite backups or exported logs.

Microsoft token caches and server sessions live in the backend data volume.
Host/volume administrators can access these files. Proxy encryption does not
encrypt the whole database or Microsoft token cache. Restrict and protect host
access and backups accordingly.

The frontend image contains only its static build. Environment files and local
data are excluded from Git and Docker build contexts. API responses use
`private, no-store` except public textures. Caddy adds CSP, frame protection and
MIME/referrer/permissions headers. CSP permits inline styles for React/editor
rendering, but no inline scripts or `eval`.

## Deployment boundaries

Use external HTTPS and secure cookies; HSTS cannot provide TLS itself. Keep
backend port 4000 off the public network. `TRUSTED_PROXIES` defaults to
`loopback,uniquelocal` for the internal Compose network, replacing unconditional
forwarded-header trust. Narrow it to the real proxies where possible; never
trust arbitrary public clients.

Login limits/IP bans depend on safe client-IP forwarding through the entire
proxy chain. Cloudflare Tunnel and direct Cloudflare proxy deployments need
different Caddy trust settings. Verify distinct visitor IPs and rejection of
forged forwarding headers. Consult the
[Caddy proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).
The deployed Pi/Cloudflare configuration must be checked separately.

Assigned Minecraft-account operators can choose server hosts/ports, permitting
outbound TCP connections from the backend, including to internal addresses.
Only grant operator access to trusted users or restrict egress separately.

## Dependencies and verification

On 2026-10-08, `npm audit` reports zero known advisories in both lockfiles,
including development dependencies. Re-run it regularly. Backend overrides
patch transitive packages while retaining Bedrock `3.58.2` for Node 20;
newer Bedrock releases require Node 24. Node 20 checks cover archive extraction,
MSAL cache serialization and native transport loading.

`backend/test/security/website.test.ts` exercises real local sockets, account
isolation, session/permission revocation, CSRF/Origin validation, login limits,
payload rejection and audit redaction. Additional tests cover notes, uploads
and minigame authorization.
