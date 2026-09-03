# Security Overview

This document maps the project's security posture to a checklist of common
requirements. The service is a **Prisma/SQLite + server-side session** app: the
React frontend only ever talks to the backend HTTP/WebSocket API — it never
touches the database directly and holds no database credentials. Several
"public/admin DB key" style items therefore map to the API/auth layer rather
than to a client-side database SDK.

| # | Requirement | Status | Where / how |
|---|-------------|--------|-------------|
| 1 | Hide API keys | ✅ | No third-party API keys ship to the client. Server secrets (`SESSION_SECRET`, `ENCRYPTION_KEY`, `INITIAL_ADMIN_PASSWORD`) come from `.env`, which is git-ignored. Only `.env.example` with placeholders is committed. |
| 2 | Purge git secrets | ✅ | No real `.env` or key material is or ever was tracked (verified across git history). `.gitignore` excludes `.env`, `*.local`, DB files, and the on-disk MS token cache (`backend/data/`). |
| 3 | Use public DB key | ✅ (N/A by design) | The frontend has **no** database access; all data goes through the authenticated backend API. There is no client-exposed DB key to leak. |
| 4 | Row-level security | ✅ (app-level) | Every query is scoped to the session user: `listAccountsForSession`, `getAccountForSession`, `canAccessAccount` filter by `assignments`; admins see all, users see only assigned accounts. |
| 5 | Encrypt sensitive data | ✅ | Proxy URLs (may embed `user:pass@host`) are encrypted at rest with AES-256-GCM (`utils/crypto.ts`), keyed from `ENCRYPTION_KEY` (falls back to `SESSION_SECRET`). Minecraft passwords are never stored (Microsoft device-code auth only; legacy passwords purged on boot). |
| 6 | Enforce server-side auth | ✅ | `requireAuth`/`requireAdmin` preHandlers on every protected route; WebSocket upgrades validate the session cookie before accepting the connection. |
| 7 | Lock record access | ✅ | Ownership is re-checked server-side on every read/write/lifecycle/command action; unauthorized access returns 404 (no existence leak). |
| 8 | Block field tampering | ✅ | Zod whitelist schemas strip unknown keys; write-once fields (`credentialsSecret`, `authType`, `edition`, sniper `email`) are omitted from update schemas. Sensitive columns are excluded from `publicAccountSelect`/`publicSniperSelect`. |
| 9 | Secure session cookies | ✅ | `httpOnly`, `sameSite=lax`, `secure` (prod). Server-side sessions (revocable); wiped on every backend restart; DB-side absolute TTL. CSRF via double-submit cookie (`afk_csrf` + `x-csrf-token`). |
| 10 | Hash passwords | ✅ | Argon2id (`auth/password.ts`), OWASP-recommended parameters tuned for the Pi. |
| 11 | Rate limit login | ✅ | `/api/auth/login` override (`LOGIN_RATE_LIMIT_MAX`, default 5/min) on top of a 200/min global limit. |
| 12 | Bot protection | ✅ | Global + per-login rate limiting, plus **auto-ban** of IPs after repeated failed logins (see #23). |
| 13 | Parameterize queries | ✅ | All DB access is via Prisma (parameterized); no raw/string-built SQL anywhere. |
| 14 | Validate all input | ✅ | Zod schemas on every route body/params via `parseOrReject`; numeric ranges, regexes and length caps throughout. |
| 15 | Escape user content | ✅ | React escapes by default; no `dangerouslySetInnerHTML` in the codebase. API returns JSON only. |
| 16 | Restrict file uploads | ✅ (N/A) | The app exposes no file-upload endpoints. The favicon/app icon is a build-time static asset, not a user upload. |
| 17 | Trim API responses | ✅ | Explicit `select` allow-lists (`publicAccountSelect`, `publicSniperSelect`) keep credentials/secrets out of responses; the error handler hides internal 500 details. |
| 18 | Security headers | ✅ | `@fastify/helmet` (incl. HSTS in prod) at the API; Caddy adds `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and removes the `Server` header. |
| 19 | Enforce HTTPS | ✅ | Cloudflare/Caddy terminate TLS; `secure` cookies in prod; HSTS (1 year, `includeSubDomains`, `preload`). |
| 20 | Scan dependencies | ✅ | `npm run audit` (backend). See "Dependency advisories" below for the current state and mitigations. |
| 21 | Verify ownership before returning data | ✅ | Same as #4/#7 — every handler confirms the session user owns/for-admin can access the record before responding. |
| 22 | Frontend uses limited key; admin key server-side | ✅ (mapped) | No DB keys in the frontend at all. Privileged operations are gated behind `requireAdmin` server-side; the client only holds a session cookie scoped to the logged-in user's permissions. |
| 23 | IP bans | ✅ | Admin-managed ban list (`BannedIp` table, `/api/security/ip-bans`) enforced by a global `onRequest` guard using an in-memory cache; plus automatic banning after repeated failed logins from one IP. |

## Encryption at rest (#5)

`backend/src/utils/crypto.ts` provides `encryptSecret`/`decryptSecret` using
AES-256-GCM. Stored values use the form `enc:v1:<base64(iv|tag|ciphertext)>`.
Values without the prefix are treated as legacy plaintext and returned
unchanged, so the feature was introduced without a data migration. The Name
Sniper `proxies` column is encrypted on write and decrypted transparently on
read (frontend display and runtime use).

Set a dedicated `ENCRYPTION_KEY` in production (`openssl rand -hex 32`). If it
is rotated, previously-encrypted values become unreadable and fail closed to an
empty value — re-enter proxies after a key change.

## IP bans & auto-ban (#23, #12)

- Admins manage bans in the **Users** page ("IP bans" card) or via
  `GET/POST/DELETE /api/security/ip-bans`.
- A global `onRequest` hook rejects banned IPs with HTTP 403 before any auth,
  rate-limit accounting or handler runs, using an in-memory `Set` refreshed at
  startup and on every ban/unban.
- After 15 failed logins from the same IP within 10 minutes, that IP is
  automatically banned (`auto: true`). Successful login clears the counter.
- Admins cannot ban the IP they are currently connected from (lock-out guard).
- `trustProxy` is enabled so `req.ip` reflects the real client behind
  Cloudflare/Caddy.

## Dependency advisories (#20)

Run `npm run audit` in `backend/`. The remaining advisories are **transitive**
dependencies of the Bedrock-Edition bot toolchain
(`bedrock-protocol → prismarine-auth → @azure/msal-node → uuid`, plus
`fast-uri` under Fastify). npm only offers a fix via `npm audit fix --force`,
which downgrades `bedrock-protocol` to an older major (a breaking change), so it
is intentionally **not** applied automatically.

Mitigations:
- Fastify is kept on the latest patch release.
- The Bedrock path is only exercised for Bedrock accounts and does not process
  untrusted web input; the affected `uuid`/`msal` code runs against Microsoft's
  own auth endpoints.
- `fast-uri`/`axios` SSRF-class issues are not reachable from user-controlled
  request routing in this app (no user-supplied URL fetching on the server).

Re-evaluate when `bedrock-protocol` ships a non-breaking fix.
